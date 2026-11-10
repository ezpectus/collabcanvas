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

// T-19: known documents. Set maintained by JoinDocument; empty when
// Redis is down (fail-open — discovery degrades, docs don't vanish).
app.MapGet("/docs", async (IConnectionMultiplexer redis) =>
{
    try
    {
        var ids = await redis.GetDatabase().SetMembersAsync("docs");
        return Results.Ok(ids.Select(v => v.ToString()).Take(200).ToArray());
    }
    catch (RedisException) { return Results.Ok(Array.Empty<string>()); }
});

// T-24: op history tail — what the journal still remembers. This is
// an AUDIT view, not time travel: MAXLEN means pre-trim history is
// gone and restore-from-seq is deliberately out of scope.
app.MapGet("/ops", (CollabCanvas.Core.Journal.IOpJournalFactory journals,
    string doc, int? n) =>
{
    if (string.IsNullOrWhiteSpace(doc) || doc.Length > 64)
        return Results.BadRequest("bad doc");
    var take = Math.Clamp(n ?? 100, 1, 500);
    var ops = journals.ForDoc(doc).Tail(take).Select(o =>
        new { o.Seq, Type = o.Type.ToString(), o.ClientId, o.ClientSeq });
    return Results.Ok(ops);
});

// T-32: remove a doc from the discovery list. Journal/snapshot are
// NOT deleted (no destroy semantics without auth) — this only stops
// advertising it; re-joining re-adds it. Reversible by design.
app.MapDelete("/docs/{id}", async (IConnectionMultiplexer redis, string id) =>
{
    if (string.IsNullOrWhiteSpace(id) || id.Length > 64)
        return Results.BadRequest("bad id");
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

app.MapHub<DocumentHub>("/hubs/document");

app.Run();

// Marker for WebApplicationFactory<Program> in tests.
public partial class Program;
