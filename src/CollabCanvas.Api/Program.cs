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
    var id = Convert.ToBase64String(
        System.Security.Cryptography.RandomNumberGenerator.GetBytes(9))
        .Replace('+', '-').Replace('/', '_'); // 12-char url-safe id
    await members.SetRoleAsync(id, who.Value.login,
        CollabCanvas.Api.Auth.RoomRole.Owner);
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
    if (await CallerRole(members, users, req, doc) is null)
        return Results.StatusCode(403);
    var take = Math.Clamp(n ?? 100, 1, 500);
    var ops = journals.ForDoc(doc).Tail(take).Select(o =>
        new { o.Seq, Type = o.Type.ToString(), o.ClientId, o.ClientSeq });
    return Results.Ok(ops);
});

// T-32: remove a doc from the discovery list. Journal/snapshot are
// NOT deleted (no destroy semantics without auth) — this only stops
// advertising it; re-joining re-adds it. Reversible by design.
app.MapDelete("/docs/{id}", async (
    IConnectionMultiplexer redis,
    CollabCanvas.Api.Auth.MembershipStore members,
    CollabCanvas.Api.Auth.UserStore users,
    HttpRequest req, string id) =>
{
    if (string.IsNullOrWhiteSpace(id) || id.Length > 64)
        return Results.BadRequest("bad id");
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
    System.Text.Json.JsonElement body) =>
{
    var login = body.TryGetProperty("login", out var l) ? l.GetString() : null;
    var pass = body.TryGetProperty("password", out var p) ? p.GetString() : null;
    if (login is null || pass is null) return Results.BadRequest("login+password");
    var token = await users.LoginAsync(login, pass);
    // Same answer for unknown user and wrong password — don't leak
    // which logins exist (standard enumeration hardening).
    return token is null ? Results.Unauthorized()
                       : Results.Ok(new { token, login });
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
    HttpRequest req, string docId)
{
    if (!await members.IsOwnedAsync(docId))
        return CollabCanvas.Api.Auth.RoomRole.Editor;
    return await users.ResolveAsync(Bearer(req)) is { } who
        ? await members.RoleOfAsync(docId, who.login)
        : null;
}

app.MapHub<DocumentHub>("/hubs/document");

app.Run();

// Marker for WebApplicationFactory<Program> in tests.
public partial class Program;
