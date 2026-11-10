using StackExchange.Redis;

namespace CollabCanvas.Api.Endpoints;

/// Account/session endpoints (T-26 stage 1 + T-47). Server-side
/// tokens only — no JWT; revocation is a key delete.
internal static class AuthEndpoints
{
    public static WebApplication MapAuthEndpoints(this WebApplication app)
    {
        app.MapPost("/auth/register", async (
            Auth.UserStore users,
            System.Text.Json.JsonElement body) =>
        {
            var login = body.TryGetProperty("login", out var l) ? l.GetString() : null;
            var pass = body.TryGetProperty("password", out var p) ? p.GetString() : null;
            if (login is null || pass is null) return Results.BadRequest("login+password");
            var (res, token) = await users.RegisterAsync(login, pass);
            return res switch
            {
                Auth.UserStore.RegResult.Ok =>
                    Results.Ok(new { token, login }),
                Auth.UserStore.RegResult.Taken =>
                    Results.Conflict("login taken"),
                _ => Results.BadRequest("login 2-32 [a-z0-9_-], pass 6..72B"),
            };
        });

        app.MapPost("/auth/login", async (
            Auth.UserStore users,
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
            Auth.UserStore users, HttpRequest req) =>
        {
            var token = Authz.Bearer(req);
            var who = await users.ResolveAsync(token);
            return who is null ? Results.Unauthorized()
                               : Results.Ok(new { id = who.Value.id, login = who.Value.login });
        });

        app.MapPost("/auth/logout", async (
            Auth.UserStore users, HttpRequest req) =>
        {
            var token = Authz.Bearer(req);
            if (token is not null) await users.LogoutAsync(token);
            return Results.NoContent();
        });

        // Password change: verifies the old hash, rehashes, then revokes
        // every OTHER live session — a leaked old token dies with the
        // password. The caller's own token survives.
        app.MapPost("/auth/password", async (
            Auth.UserStore users,
            System.Text.Json.JsonElement body, HttpRequest req) =>
        {
            var token = Authz.Bearer(req);
            var who = await users.ResolveAsync(token);
            if (who is null || token is null) return Results.Unauthorized();
            var oldPw = body.TryGetProperty("old", out var o)
                ? o.GetString() : null;
            var newPw = body.TryGetProperty("new", out var n)
                ? n.GetString() : null;
            if (string.IsNullOrEmpty(oldPw) || newPw is null ||
                !Auth.UserStore.PasswordOk(newPw))
                return Results.BadRequest("old + new(6..72B) required");
            return await users.ChangePasswordAsync(
                who.Value.id, who.Value.login, oldPw, newPw, token)
                ? Results.NoContent()
                : Results.StatusCode(403);
        });

        return app;
    }
}
