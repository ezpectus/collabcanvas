using StackExchange.Redis;

namespace CollabCanvas.Api.Endpoints;

/// T-36: image blobs — Redis store for MVP (single-stack choice:
/// no new service; caps keep memory honest — 5MB/blob, 50/doc;
/// a real image pipeline would move bytes to disk/S3, documented).
internal static class BlobEndpoints
{
    public static WebApplication MapBlobEndpoints(this WebApplication app)
    {
        app.MapPost("/docs/{id}/blobs", async (
            string id, IConnectionMultiplexer redis,
            Auth.MembershipStore members,
            Auth.UserStore users,
            HttpRequest req) =>
        {
            // Upload = a document mutation: editor+ (or legacy-open).
            var cr = await Authz.CallerRole(members, users, req, id,
                req.Query["grant"]);
            if (cr is null || cr < Auth.RoomRole.Editor)
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
            var blobId = Convert.ToBase64String(
                System.Security.Cryptography.RandomNumberGenerator.GetBytes(12))
                .Replace('+', '-').Replace('/', '_');
            // Atomic quota+write in one Lua script — the old SCARD→SADD gap
            // let two parallel uploads both pass the 50-cap. ts seeds the
            // snapshot-sweeper's grace window (upload → Create-op gap).
            var admitted = (long)await db.ScriptEvaluateAsync(@"
                if redis.call('SCARD', KEYS[3]) >= 50 then return 0 end
                redis.call('SET', KEYS[1], ARGV[1])
                redis.call('HSET', KEYS[2],
                    'doc', ARGV[2], 'type', ARGV[3], 'size', ARGV[4], 'ts', ARGV[5])
                redis.call('SADD', KEYS[3], ARGV[6])
                return 1",
                [$"blob:{blobId}", $"blob:{blobId}:meta", $"doc:{id}:blobs"],
                [(RedisValue)ms.ToArray(), id, type, ms.Length.ToString(),
                    DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(), blobId]);
            if (admitted == 0) return Results.StatusCode(429);
            return Results.Ok(new { id = blobId });
        });

        // Read = same rule as /ops: owned doc → member or grant holder.
        // img tags can't send Authorization — token/grant ride the query.
        app.MapGet("/blobs/{id}", async (
            string id, IConnectionMultiplexer redis,
            Auth.MembershipStore members,
            Auth.UserStore users, HttpRequest req) =>
        {
            var doc = await redis.GetDatabase().HashGetAsync($"blob:{id}:meta", "doc");
            if (doc.IsNullOrEmpty) return Results.NotFound();
            var cr = await Authz.CallerRole(members, users, req, doc.ToString()!,
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

        return app;
    }
}
