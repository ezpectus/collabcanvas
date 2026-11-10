using StackExchange.Redis;

namespace CollabCanvas.Api.Endpoints;

/// Document-scoped HTTP surface: discovery, creation, membership,
/// link grants, meta, ops-tail, comments, delist + destroy. Every
/// lambda stays thin — role check → store call → result. Anything
/// heavier belongs in a store, not here.
internal static class DocEndpoints
{
    public static WebApplication MapDocEndpoints(this WebApplication app)
    {
        // T-19 + T-26 stage 2: known documents, filtered by caller's access.
        // Authed → member docs ∪ unowned(open) docs; guest → unowned only.
        // An owned doc's id must not leak to strangers through discovery.
        app.MapGet("/docs", async (
            IConnectionMultiplexer redis,
            Auth.MembershipStore members,
            Auth.UserStore users,
            HttpRequest req) =>
        {
            try
            {
                var all = (await redis.GetDatabase().SetMembersAsync("docs"))
                    .Select(v => v.ToString());
                var owned = await members.OwnedDocIdsAsync();
                var open = all.Where(id => !owned.Contains(id));
                var who = await users.ResolveAsync(Authz.Bearer(req));
                var visible = who is null
                    ? open
                    : open.Union(await members.DocsOfAsync(who.Value.login));
                return Results.Ok(visible.Take(200).ToArray());
            }
            catch (RedisException) { return Results.Ok(Array.Empty<string>()); }
        });

        // T-26 stage 2: THE way to get an owned doc — explicit create while
        // signed in. Implicit join of unowned docs stays open (legacy); no
        // first-claim, so signing in can't steal docs others edit anonymously.
        app.MapPost("/docs", async (
            Auth.UserStore users,
            Auth.MembershipStore members,
            IConnectionMultiplexer redis,
            HttpRequest req) =>
        {
            var who = await users.ResolveAsync(Authz.Bearer(req));
            if (who is null) return Results.Unauthorized();
            // Doc-mint quota: a scripted account shouldn't flood the
            // discovery set and journal keys without bound.
            if ((await members.DocsOfAsync(who.Value.login)).Length >= 200)
                return Results.StatusCode(429);
            var id = Convert.ToBase64String(
                System.Security.Cryptography.RandomNumberGenerator.GetBytes(9))
                .Replace('+', '-').Replace('/', '_'); // 12-char url-safe id
            await members.SetRoleAsync(id, who.Value.login,
                Auth.RoomRole.Owner);
            await members.ResurrectAsync(id); // id is random — dead-marker safety
            await redis.GetDatabase().SetAddAsync("docs", id);
            return Results.Ok(new { id, role = "owner" });
        });

        // T-32: delist is reversible; ?hard=1 is the real destroy —
        // owner only, every trace goes (members, links, meta, journal,
        // snapshot, blobs, comments, indexes) + a tombstone that blocks
        // resurrection through the legacy-open path.
        app.MapDelete("/docs/{id}", async (
            IConnectionMultiplexer redis,
            Auth.MembershipStore members,
            Auth.UserStore users,
            HttpRequest req, string id) =>
        {
            if (string.IsNullOrWhiteSpace(id) || id.Length > 64)
                return Results.BadRequest("bad id");
            if (req.Query["hard"] == "1")
            {
                if (await Authz.CallerRole(members, users, req, id) is not { } hc ||
                    hc != Auth.RoomRole.Owner)
                    return Results.StatusCode(403);
                await members.DestroyAsync(id);
                return Results.NoContent();
            }
            // Owned doc → owner/admin only; unowned stays open (reversible
            // delist is a low-cost op on a doc nobody claims).
            if (await members.IsOwnedAsync(id) &&
                (await Authz.CallerRole(members, users, req, id) is not { } cr ||
                 cr < Auth.RoomRole.Admin))
                return Results.StatusCode(403);
            try
            {
                await redis.GetDatabase().SetRemoveAsync("docs", id);
                return Results.NoContent();
            }
            catch (RedisException) { return Results.Ok(); }
        });

        // Member management — owner/admin only. Admin can manage
        // editor/viewer; only an owner touches admins or the owner seat.
        app.MapGet("/docs/{id}/members", async (
            string id,
            Auth.MembershipStore members,
            Auth.UserStore users, HttpRequest req) =>
        {
            var caller = await Authz.CallerRole(members, users, req, id);
            if (caller is null || caller < Auth.RoomRole.Admin)
                return Results.StatusCode(403);
            var ms = await members.MembersAsync(id);
            return Results.Ok(ms.ToDictionary(
                kv => kv.Key, kv => Auth.MembershipStore.Name(kv.Value)));
        });

        app.MapPost("/docs/{id}/members", async (
            string id,
            Auth.MembershipStore members,
            Auth.UserStore users,
            IConnectionMultiplexer redis,
            System.Text.Json.JsonElement body, HttpRequest req) =>
        {
            var caller = await Authz.CallerRole(members, users, req, id);
            if (caller is null || caller < Auth.RoomRole.Admin)
                return Results.StatusCode(403);
            var login = body.TryGetProperty("login", out var l) ? l.GetString() : null;
            var role = Auth.MembershipStore.ParseRole(
                body.TryGetProperty("role", out var r) ? r.GetString() : null);
            if (login is null || role is null || role == Auth.RoomRole.Owner)
                return Results.BadRequest("login + role(admin|editor|viewer)");
            // Only an owner may seat another admin — admins can't self-appoint.
            if (role == Auth.RoomRole.Admin &&
                caller != Auth.RoomRole.Owner)
                return Results.StatusCode(403);
            if (!await redis.GetDatabase().KeyExistsAsync($"user:{login}"))
                return Results.BadRequest("no such login");
            await members.SetRoleAsync(id, login, role.Value);
            return Results.NoContent();
        });

        app.MapDelete("/docs/{id}/members/{login}", async (
            string id, string login,
            Auth.MembershipStore members,
            Auth.UserStore users, HttpRequest req) =>
        {
            var caller = await Authz.CallerRole(members, users, req, id);
            if (caller is null || caller < Auth.RoomRole.Admin)
                return Results.StatusCode(403);
            var target = await members.RoleOfAsync(id, login);
            if (target is null) return Results.NotFound();
            // Owner seat can't be emptied through this door; only an owner
            // removes an admin (no admin-on-admin power struggles).
            if (target == Auth.RoomRole.Owner ||
                (target == Auth.RoomRole.Admin &&
                 caller != Auth.RoomRole.Owner))
                return Results.StatusCode(403);
            await members.RemoveRoleAsync(id, login);
            return Results.NoContent();
        });

        // Ownership transfer — owner only, target must already be a member
        // (handing a doc to a stranger/link-token isn't allowed). Former
        // owner drops to admin — keeps manage rights, loses destroy/transfer.
        app.MapPost("/docs/{id}/owner", async (
            string id,
            Auth.MembershipStore members,
            Auth.UserStore users,
            System.Text.Json.JsonElement body, HttpRequest req) =>
        {
            var caller = await Authz.CallerRole(members, users, req, id);
            if (caller != Auth.RoomRole.Owner)
                return Results.StatusCode(403);
            var login = body.TryGetProperty("login", out var l)
                ? l.GetString() : null;
            if (string.IsNullOrWhiteSpace(login))
                return Results.BadRequest("login required");
            if (await members.RoleOfAsync(id, login) is not { } cur ||
                cur == Auth.RoomRole.Owner)
                return Results.BadRequest("target must be a non-owner member");
            var who = await users.ResolveAsync(Authz.Bearer(req));
            await members.SetRoleAsync(id, login,
                Auth.RoomRole.Owner);
            await members.SetRoleAsync(id, who!.Value.login,
                Auth.RoomRole.Admin);
            return Results.NoContent();
        });

        // T-26 stage 3: share links — bearer capability, viewer|editor ONLY.
        // A link is "anyone with this URL gets role X"; owner/admin can't be
        // granted by link (a leaked owner-link hands the whole doc away).
        app.MapGet("/docs/{id}/links", async (
            string id,
            Auth.MembershipStore members,
            Auth.UserStore users, HttpRequest req) =>
        {
            var caller = await Authz.CallerRole(members, users, req, id);
            if (caller is null || caller < Auth.RoomRole.Admin)
                return Results.StatusCode(403);
            var ls = await members.LinksAsync(id);
            return Results.Ok(ls.ToDictionary(kv => kv.Key,
                kv => new { role = Auth.MembershipStore.Name(kv.Value.Role),
                    exp = kv.Value.ExpiryUnix }));
        });

        app.MapPost("/docs/{id}/links", async (
            string id,
            Auth.MembershipStore members,
            Auth.UserStore users,
            System.Text.Json.JsonElement body, HttpRequest req) =>
        {
            var caller = await Authz.CallerRole(members, users, req, id);
            if (caller is null || caller < Auth.RoomRole.Admin)
                return Results.StatusCode(403);
            var role = Auth.MembershipStore.ParseRole(
                body.TryGetProperty("role", out var r) ? r.GetString() : null);
            if (role is not Auth.RoomRole.Viewer and
                not Auth.RoomRole.Editor)
                return Results.BadRequest("role viewer|editor only");
            // Optional expiry — a bearer link shouldn't live forever by
            // default. ttlHours 1..720 (30d); omitted = no expiry.
            TimeSpan? ttl = null;
            if (body.TryGetProperty("ttlHours", out var th) &&
                th.ValueKind == System.Text.Json.JsonValueKind.Number)
            {
                var hours = th.GetDouble();
                if (hours is < 1 or > 720) return Results.BadRequest("ttlHours 1..720");
                ttl = TimeSpan.FromHours(hours);
            }
            var token = await members.NewLinkAsync(id, role.Value, ttl);
            return Results.Ok(new { token, role = Auth.MembershipStore.Name(role.Value) });
        });

        app.MapDelete("/docs/{id}/links/{token}", async (
            string id, string token,
            Auth.MembershipStore members,
            Auth.UserStore users, HttpRequest req) =>
        {
            var caller = await Authz.CallerRole(members, users, req, id);
            if (caller is null || caller < Auth.RoomRole.Admin)
                return Results.StatusCode(403);
            await members.RemoveLinkAsync(id, token);
            return Results.NoContent();
        });

        // T-27: document metadata (name). First real meta model — stream
        // keys alone were never it. doc:{id}:meta hash {name}. Rename is
        // owner/admin only (needs the membership layer — that's why this
        // ticket waited for T-26).
        app.MapGet("/docs/{id}/meta", async (
            string id, IConnectionMultiplexer redis,
            Auth.MembershipStore members,
            Auth.UserStore users, HttpRequest req) =>
        {
            // Meta read = same rule as ops: owned → members only.
            if (await Authz.CallerRole(members, users, req, id) is null)
                return Results.StatusCode(403);
            var name = await redis.GetDatabase().HashGetAsync($"doc:{id}:meta", "name");
            return Results.Ok(new { id, name = name.IsNullOrEmpty ? null : name.ToString() });
        });

        app.MapPatch("/docs/{id}", async (
            string id, IConnectionMultiplexer redis,
            Auth.MembershipStore members,
            Auth.UserStore users,
            System.Text.Json.JsonElement body, HttpRequest req) =>
        {
            if (await members.IsOwnedAsync(id) &&
                (await Authz.CallerRole(members, users, req, id) is not { } cr ||
                 cr < Auth.RoomRole.Admin))
                return Results.StatusCode(403);
            var name = body.TryGetProperty("name", out var n) ? n.GetString() : null;
            if (name is null || name.Trim().Length is 0 or > 64)
                return Results.BadRequest("name 1..64 chars");
            await redis.GetDatabase().HashSetAsync($"doc:{id}:meta", "name", name.Trim());
            return Results.NoContent();
        });

        // T-24: op history tail — what the journal still remembers. This is
        // an AUDIT view, not time travel: MAXLEN means pre-trim history is
        // gone and restore-from-seq is deliberately out of scope.
        app.MapGet("/ops", async (
            Core.Journal.IOpJournalFactory journals,
            Auth.MembershipStore members,
            Auth.UserStore users,
            HttpRequest req, string doc, int? n) =>
        {
            if (string.IsNullOrWhiteSpace(doc) || doc.Length > 64)
                return Results.BadRequest("bad doc");
            // Ops carry document content — same access rule as joining:
            // owned doc → members only; unowned → open.
            if (await Authz.CallerRole(members, users, req, doc,
                req.Query["grant"]) is null)
                return Results.StatusCode(403);
            var take = Math.Clamp(n ?? 100, 1, 500);
            var ops = journals.ForDoc(doc).Tail(take).Select(o =>
                new { o.Seq, Type = o.Type.ToString(), o.ClientId, o.ClientSeq });
            return Results.Ok(ops);
        });

        // Comments list — initial load for the panel; live adds/dels ride
        // the hub "comment" broadcast. Viewer+ can read, writes are hub-only.
        app.MapGet("/docs/{id}/comments", async (
            string id,
            Auth.MembershipStore members,
            Auth.UserStore users,
            Comments.DocCommentStore comments,
            HttpRequest req) =>
        {
            var g = req.Query["grant"].ToString();
            var caller = await Authz.CallerRole(members, users, req, id,
                string.IsNullOrEmpty(g) ? null : g);
            if (caller is null) return Results.StatusCode(403);
            var cs = await comments.ListAsync(id);
            return Results.Ok(cs.Select(c => new
                { id = c.Id, a = c.Author, t = c.Text, ts = c.Ts }));
        });

        return app;
    }
}
