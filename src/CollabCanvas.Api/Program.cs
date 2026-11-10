using CollabCanvas.Api.Hubs;
using StackExchange.Redis;

var builder = WebApplication.CreateBuilder(args);

// OpType travels as "Create"/"Patch"/... on the wire, not 0/1/2 —
// the TS client matches string literals.
builder.Services.AddSignalR().AddJsonProtocol(o =>
    o.PayloadSerializerOptions.Converters.Add(
        new System.Text.Json.Serialization.JsonStringEnumConverter()));
builder.Services.AddSingleton<CollabCanvas.Core.Journal.IOpJournalFactory,
    CollabCanvas.Api.Journal.RedisOpJournalFactory>();
builder.Services.AddSingleton<CollabCanvas.Core.Room.RoomManager>();
builder.Services.AddSingleton(new CollabCanvas.Core.Room.OpRateLimiter());
builder.Services.AddSingleton<CollabCanvas.Core.Room.IRoomTransport,
    CollabCanvas.Api.Journal.RedisRoomTransport>();
builder.Services.AddSingleton<CollabCanvas.Api.Presence.OpRouter>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<CollabCanvas.Api.Presence.OpRouter>());
builder.Services.AddHostedService<CollabCanvas.Api.Presence.PresenceSweeper>();
builder.Services.AddSingleton<CollabCanvas.Api.Auth.UserStore>();
builder.Services.AddSingleton<CollabCanvas.Api.Auth.MembershipStore>();
// Redis is the journal (T-5) — the app must boot without it.
// AbortOnConnectFail=false: the mux returns immediately and retries
// in the background; /health reports "degraded" until it lands.
builder.Services.AddSingleton<IConnectionMultiplexer>(_ =>
    ConnectionMultiplexer.Connect(ConfigurationOptions.Parse(
        (builder.Configuration.GetConnectionString("Redis") ?? "localhost:6379")
        + ",abortConnect=false")));

// Dev frontend on :5173 (vite) and :3100 (compose nginx) call the API
// cross-origin — SignalR negotiate needs CORS for those origins.
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p
    .WithOrigins("http://localhost:5173", "http://localhost:3100")
    .AllowAnyHeader()
    .AllowAnyMethod()
    .AllowCredentials()));

var app = builder.Build();
app.UseCors();

app.MapGet("/health", async (IConnectionMultiplexer redis, CancellationToken ct) =>
{
    var redisOk = false;
    try { redisOk = (await redis.GetDatabase().PingAsync()).TotalMilliseconds >= 0; }
    catch (RedisException) { /* fail-open: report degraded, don't throw */ }

    return Results.Json(
        new { status = redisOk ? "ok" : "degraded", redis = redisOk },
        statusCode: redisOk ? 200 : 503);
});

// T-19 + T-26 stage 2: known documents, filtered by caller's access.
// Authed → member docs ∪ unowned(open) docs; guest → unowned only.
// An owned doc's id must not leak to strangers through discovery.
app.MapGet("/docs", async (
    IConnectionMultiplexer redis,
    CollabCanvas.Api.Auth.MembershipStore members,
    CollabCanvas.Api.Auth.UserStore users,
    HttpRequest req) =>
{
    try
    {
        var all = (await redis.GetDatabase().SetMembersAsync("docs"))
            .Select(v => v.ToString());
        var owned = await members.OwnedDocIdsAsync();
        var open = all.Where(id => !owned.Contains(id));
        var who = await users.ResolveAsync(Bearer(req));
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
    CollabCanvas.Api.Auth.UserStore users,
    CollabCanvas.Api.Auth.MembershipStore members,
    IConnectionMultiplexer redis,
    HttpRequest req) =>
{
    var who = await users.ResolveAsync(Bearer(req));
    if (who is null) return Results.Unauthorized();
    // Doc-mint quota: a scripted account shouldn't flood the
    // discovery set and journal keys without bound.
    if ((await members.DocsOfAsync(who.Value.login)).Length >= 200)
        return Results.StatusCode(429);
    var id = Convert.ToBase64String(
        System.Security.Cryptography.RandomNumberGenerator.GetBytes(9))
        .Replace('+', '-').Replace('/', '_'); // 12-char url-safe id
    await members.SetRoleAsync(id, who.Value.login,
        CollabCanvas.Api.Auth.RoomRole.Owner);
    await members.ResurrectAsync(id); // id is random — dead-marker safety
    await redis.GetDatabase().SetAddAsync("docs", id);
    return Results.Ok(new { id, role = "owner" });
});

// Member management — owner/admin only. Admin can manage
// editor/viewer; only an owner touches admins or the owner seat.
app.MapGet("/docs/{id}/members", async (
    string id,
    CollabCanvas.Api.Auth.MembershipStore members,
    CollabCanvas.Api.Auth.UserStore users, HttpRequest req) =>
{
    var caller = await CallerRole(members, users, req, id);
    if (caller is null || caller < CollabCanvas.Api.Auth.RoomRole.Admin)
        return Results.StatusCode(403);
    var ms = await members.MembersAsync(id);
    return Results.Ok(ms.ToDictionary(
        kv => kv.Key, kv => CollabCanvas.Api.Auth.MembershipStore.Name(kv.Value)));
});

app.MapPost("/docs/{id}/members", async (
    string id,
    CollabCanvas.Api.Auth.MembershipStore members,
    CollabCanvas.Api.Auth.UserStore users,
    IConnectionMultiplexer redis,
    System.Text.Json.JsonElement body, HttpRequest req) =>
{
    var caller = await CallerRole(members, users, req, id);
    if (caller is null || caller < CollabCanvas.Api.Auth.RoomRole.Admin)
        return Results.StatusCode(403);
    var login = body.TryGetProperty("login", out var l) ? l.GetString() : null;
    var role = CollabCanvas.Api.Auth.MembershipStore.ParseRole(
        body.TryGetProperty("role", out var r) ? r.GetString() : null);
    if (login is null || role is null || role == CollabCanvas.Api.Auth.RoomRole.Owner)
        return Results.BadRequest("login + role(admin|editor|viewer)");
    // Only an owner may seat another admin — admins can't self-appoint.
    if (role == CollabCanvas.Api.Auth.RoomRole.Admin &&
        caller != CollabCanvas.Api.Auth.RoomRole.Owner)
        return Results.StatusCode(403);
    if (!await redis.GetDatabase().KeyExistsAsync($"user:{login}"))
        return Results.BadRequest("no such login");
    await members.SetRoleAsync(id, login, role.Value);
    return Results.NoContent();
});

// T-26 stage 3: share links — bearer capability, viewer|editor ONLY.
// A link is "anyone with this URL gets role X"; owner/admin can't be
// granted by link (a leaked owner-link hands the whole doc away).
app.MapGet("/docs/{id}/links", async (
    string id,
    CollabCanvas.Api.Auth.MembershipStore members,
    CollabCanvas.Api.Auth.UserStore users, HttpRequest req) =>
{
    var caller = await CallerRole(members, users, req, id);
    if (caller is null || caller < CollabCanvas.Api.Auth.RoomRole.Admin)
        return Results.StatusCode(403);
    var ls = await members.LinksAsync(id);
    return Results.Ok(ls.ToDictionary(
        kv => kv.Key, kv => CollabCanvas.Api.Auth.MembershipStore.Name(kv.Value)));
});

app.MapPost("/docs/{id}/links", async (
    string id,
    CollabCanvas.Api.Auth.MembershipStore members,
    CollabCanvas.Api.Auth.UserStore users,
    System.Text.Json.JsonElement body, HttpRequest req) =>
{
    var caller = await CallerRole(members, users, req, id);
    if (caller is null || caller < CollabCanvas.Api.Auth.RoomRole.Admin)
        return Results.StatusCode(403);
    var role = CollabCanvas.Api.Auth.MembershipStore.ParseRole(
        body.TryGetProperty("role", out var r) ? r.GetString() : null);
    if (role is not CollabCanvas.Api.Auth.RoomRole.Viewer and
        not CollabCanvas.Api.Auth.RoomRole.Editor)
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
    return Results.Ok(new { token, role = CollabCanvas.Api.Auth.MembershipStore.Name(role.Value) });
});

app.MapDelete("/docs/{id}/links/{token}", async (
    string id, string token,
    CollabCanvas.Api.Auth.MembershipStore members,
    CollabCanvas.Api.Auth.UserStore users, HttpRequest req) =>
{
    var caller = await CallerRole(members, users, req, id);
    if (caller is null || caller < CollabCanvas.Api.Auth.RoomRole.Admin)
        return Results.StatusCode(403);
    await members.RemoveLinkAsync(id, token);
    return Results.NoContent();
});

app.MapDelete("/docs/{id}/members/{login}", async (
    string id, string login,
    CollabCanvas.Api.Auth.MembershipStore members,
    CollabCanvas.Api.Auth.UserStore users, HttpRequest req) =>
{
    var caller = await CallerRole(members, users, req, id);
    if (caller is null || caller < CollabCanvas.Api.Auth.RoomRole.Admin)
        return Results.StatusCode(403);
    var target = await members.RoleOfAsync(id, login);
    if (target is null) return Results.NotFound();
    // Owner seat can't be emptied through this door; only an owner
    // removes an admin (no admin-on-admin power struggles).
    if (target == CollabCanvas.Api.Auth.RoomRole.Owner ||
        (target == CollabCanvas.Api.Auth.RoomRole.Admin &&
         caller != CollabCanvas.Api.Auth.RoomRole.Owner))
        return Results.StatusCode(403);
    await members.RemoveRoleAsync(id, login);
    return Results.NoContent();
});

// T-24: op history tail — what the journal still remembers. This is
// an AUDIT view, not time travel: MAXLEN means pre-trim history is
// gone and restore-from-seq is deliberately out of scope.
app.MapGet("/ops", async (
    CollabCanvas.Core.Journal.IOpJournalFactory journals,
    CollabCanvas.Api.Auth.MembershipStore members,
    CollabCanvas.Api.Auth.UserStore users,
    HttpRequest req, string doc, int? n) =>
{
    if (string.IsNullOrWhiteSpace(doc) || doc.Length > 64)
        return Results.BadRequest("bad doc");
    // Ops carry document content — same access rule as joining:
    // owned doc → members only; unowned → open.
    if (await CallerRole(members, users, req, doc,
        req.Query["grant"]) is null)
        return Results.StatusCode(403);
    var take = Math.Clamp(n ?? 100, 1, 500);
    var ops = journals.ForDoc(doc).Tail(take).Select(o =>
        new { o.Seq, Type = o.Type.ToString(), o.ClientId, o.ClientSeq });
    return Results.Ok(ops);
});

// T-32: remove a doc from the discovery list. Journal/snapshot are
// NOT deleted (no destroy semantics without auth) — this only stops
// advertising it; re-joining re-adds it. Reversible by design.
// T-27: document metadata (name). First real meta model — stream
// keys alone were never it. doc:{id}:meta hash {name}. Rename is
// owner/admin only (needs the membership layer — that's why this
// ticket waited for T-26).
app.MapGet("/docs/{id}/meta", async (
    string id, IConnectionMultiplexer redis,
    CollabCanvas.Api.Auth.MembershipStore members,
    CollabCanvas.Api.Auth.UserStore users, HttpRequest req) =>
{
    // Meta read = same rule as ops: owned → members only.
    if (await CallerRole(members, users, req, id) is null)
        return Results.StatusCode(403);
    var name = await redis.GetDatabase().HashGetAsync($"doc:{id}:meta", "name");
    return Results.Ok(new { id, name = name.IsNullOrEmpty ? null : name.ToString() });
});

app.MapPatch("/docs/{id}", async (
    string id, IConnectionMultiplexer redis,
    CollabCanvas.Api.Auth.MembershipStore members,
    CollabCanvas.Api.Auth.UserStore users,
    System.Text.Json.JsonElement body, HttpRequest req) =>
{
    if (await members.IsOwnedAsync(id) &&
        (await CallerRole(members, users, req, id) is not { } cr ||
         cr < CollabCanvas.Api.Auth.RoomRole.Admin))
        return Results.StatusCode(403);
    var name = body.TryGetProperty("name", out var n) ? n.GetString() : null;
    if (name is null || name.Trim().Length is 0 or > 64)
        return Results.BadRequest("name 1..64 chars");
    await redis.GetDatabase().HashSetAsync($"doc:{id}:meta", "name", name.Trim());
    return Results.NoContent();
});

// T-36: image blobs — Redis store for MVP (single-stack choice:
// no new service; caps keep memory honest — 5MB/blob, 50/doc;
// a real image pipeline would move bytes to disk/S3, documented).
app.MapPost("/docs/{id}/blobs", async (
    string id, IConnectionMultiplexer redis,
    CollabCanvas.Api.Auth.MembershipStore members,
    CollabCanvas.Api.Auth.UserStore users,
    HttpRequest req) =>
{
    // Upload = a document mutation: editor+ (or legacy-open).
    var cr = await CallerRole(members, users, req, id,
        req.Query["grant"]);
    if (cr is null || cr < CollabCanvas.Api.Auth.RoomRole.Editor)
        return Results.StatusCode(403);
    var type = req.ContentType ?? "";
    if (type is not ("image/png" or "image/jpeg" or "image/webp"
        or "image/gif"))
        return Results.BadRequest("png/jpeg/webp/gif only");
    var ms = new System.IO.MemoryStream();
    await req.Body.CopyToAsync(ms);
    if (ms.Length is 0 or > 5_000_000)
        return Results.BadRequest("blob 1B..5MB");
    var db = redis.GetDatabase();
    if (await db.SetLengthAsync($"doc:{id}:blobs") >= 50)
        return Results.StatusCode(429); // per-doc blob quota
    var blobId = Convert.ToBase64String(
        System.Security.Cryptography.RandomNumberGenerator.GetBytes(12))
        .Replace('+', '-').Replace('/', '_');
    await db.StringSetAsync($"blob:{blobId}", ms.ToArray());
    await db.HashSetAsync($"blob:{blobId}:meta", [
        new("doc", id), new("type", type),
        new("size", ms.Length.ToString())]);
    await db.SetAddAsync($"doc:{id}:blobs", blobId);
    return Results.Ok(new { id = blobId });
});

// Read = same rule as /ops: owned doc → member or grant holder.
// img tags can't send Authorization — token/grant ride the query.
app.MapGet("/blobs/{id}", async (
    string id, IConnectionMultiplexer redis,
    CollabCanvas.Api.Auth.MembershipStore members,
    CollabCanvas.Api.Auth.UserStore users, HttpRequest req) =>
{
    var doc = await redis.GetDatabase().HashGetAsync($"blob:{id}:meta", "doc");
    if (doc.IsNullOrEmpty) return Results.NotFound();
    var cr = await CallerRole(members, users, req, doc.ToString()!,
        req.Query["grant"]);
    if (cr is null) return Results.StatusCode(403);
    var bytes = await redis.GetDatabase().StringGetAsync($"blob:{id}");
    var type = await redis.GetDatabase().HashGetAsync($"blob:{id}:meta", "type");
    // Stored content-type is uploader-claimed; nosniff keeps the
    // browser from re-guessing an executable type for a hostile blob.
    req.HttpContext.Response.Headers["X-Content-Type-Options"] = "nosniff";
    return bytes.IsNullOrEmpty ? Results.NotFound()
        : Results.File((byte[])bytes!, type.ToString() ?? "application/octet-stream");
});

app.MapDelete("/docs/{id}", async (
    IConnectionMultiplexer redis,
    CollabCanvas.Api.Auth.MembershipStore members,
    CollabCanvas.Api.Auth.UserStore users,
    HttpRequest req, string id) =>
{
    if (string.IsNullOrWhiteSpace(id) || id.Length > 64)
        return Results.BadRequest("bad id");
    // ?hard=1 → irreversible destroy: owner only, everything goes.
    // Plain delete stays a reversible delist (admin+).
    if (req.Query["hard"] == "1")
    {
        if (await CallerRole(members, users, req, id) is not { } hc ||
            hc != CollabCanvas.Api.Auth.RoomRole.Owner)
            return Results.StatusCode(403);
        await members.DestroyAsync(id);
        return Results.NoContent();
    }
    // Owned doc → owner/admin only; unowned stays open (reversible
    // delist is a low-cost op on a doc nobody claims).
    if (await members.IsOwnedAsync(id) &&
        (await CallerRole(members, users, req, id) is not { } cr ||
         cr < CollabCanvas.Api.Auth.RoomRole.Admin))
        return Results.StatusCode(403);
    try
    {
        await redis.GetDatabase().SetRemoveAsync("docs", id);
        return Results.NoContent();
    }
    catch (RedisException) { return Results.Ok(); }
});

// T-26 stage 1: accounts + sessions. Roles/link-grants come in
// stage 2 — a session today only proves identity (presence name,
// future membership). Guests keep legacy editor rights by design.
app.MapPost("/auth/register", async (
    CollabCanvas.Api.Auth.UserStore users,
    System.Text.Json.JsonElement body) =>
{
    var login = body.TryGetProperty("login", out var l) ? l.GetString() : null;
    var pass = body.TryGetProperty("password", out var p) ? p.GetString() : null;
    if (login is null || pass is null) return Results.BadRequest("login+password");
    var (res, token) = await users.RegisterAsync(login, pass);
    return res switch
    {
        CollabCanvas.Api.Auth.UserStore.RegResult.Ok =>
            Results.Ok(new { token, login }),
        CollabCanvas.Api.Auth.UserStore.RegResult.Taken =>
            Results.Conflict("login taken"),
        _ => Results.BadRequest("login 2-32 [a-z0-9_-], pass >= 6"),
    };
});

app.MapPost("/auth/login", async (
    CollabCanvas.Api.Auth.UserStore users,
    IConnectionMultiplexer redis,
    System.Text.Json.JsonElement body) =>
{
    var login = body.TryGetProperty("login", out var l) ? l.GetString() : null;
    var pass = body.TryGetProperty("password", out var p) ? p.GetString() : null;
    if (login is null || pass is null) return Results.BadRequest("login+password");
    // Throttle (T-26 residual hole): 8 fails / login / 10min → 429.
    // bcrypt already costs ~70ms; this stops a scripted grind, not
    // a typo. Key is per-login — per-IP would punish shared NATs.
    var rlKey = $"auth:rl:{login}";
    var fails = await redis.GetDatabase().StringGetAsync(rlKey);
    if (fails.HasValue && (int)fails >= 8)
        return Results.StatusCode(429);
    var token = await users.LoginAsync(login, pass);
    var db = redis.GetDatabase();
    if (token is null)
    {
        // INCR+EXPIRE in one transaction — a Redis blip between the
        // two calls would otherwise pin the counter (and the
        // lockout) forever.
        var tx = db.CreateTransaction();
        _ = tx.StringIncrementAsync(rlKey);
        _ = tx.KeyExpireAsync(rlKey, TimeSpan.FromMinutes(10));
        await tx.ExecuteAsync();
        // Same answer for unknown user and wrong password — don't
        // leak which logins exist (enumeration hardening).
        return Results.Unauthorized();
    }
    await db.KeyDeleteAsync(rlKey);
    return Results.Ok(new { token, login });
});

// Resolve by Authorization: Bearer <token> or ?token= (SignalR
// clients can't always set headers on negotiate).
app.MapGet("/auth/me", async (
    CollabCanvas.Api.Auth.UserStore users, HttpRequest req) =>
{
    var token = Bearer(req);
    var who = await users.ResolveAsync(token);
    return who is null ? Results.Unauthorized()
                       : Results.Ok(new { id = who.Value.id, login = who.Value.login });
});

app.MapPost("/auth/logout", async (
    CollabCanvas.Api.Auth.UserStore users, HttpRequest req) =>
{
    var token = Bearer(req);
    if (token is not null) await users.LogoutAsync(token);
    return Results.NoContent();
});

static string? Bearer(HttpRequest req)
{
    var h = req.Headers.Authorization.ToString();
    if (h.StartsWith("Bearer ", StringComparison.Ordinal))
        return h["Bearer ".Length..];
    var q = req.Query["token"].ToString();
    return string.IsNullOrEmpty(q) ? null : q;
}

/// T-26 stage 2: caller's role on a doc, same rule as the hub —
/// unowned → Editor (legacy open), owned → membership or null.
static async Task<CollabCanvas.Api.Auth.RoomRole?> CallerRole(
    CollabCanvas.Api.Auth.MembershipStore members,
    CollabCanvas.Api.Auth.UserStore users,
    HttpRequest req, string docId, object? grant = null)
{
    // Dead doc denies everything — checked before membership so a
    // destroyed doc can't resurrect via the legacy-open fallback.
    if (await members.IsDeadAsync(docId)) return null;
    // Same precedence as the hub: member > link > legacy-open.
    // A viewer grant must never downgrade a member's real role.
    if (await users.ResolveAsync(Bearer(req)) is { } who &&
        await members.RoleOfAsync(docId, who.login) is { } m)
        return m;
    var g = grant?.ToString();
    if (!string.IsNullOrEmpty(g) &&
        await members.LinkRoleAsync(docId, g) is { } link)
        return link;
    return await members.IsOwnedAsync(docId)
        ? null : CollabCanvas.Api.Auth.RoomRole.Editor;
}

app.MapHub<DocumentHub>("/hubs/document");

app.Run();

// Marker for WebApplicationFactory<Program> in tests.
public partial class Program;
