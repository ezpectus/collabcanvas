using System.Text.Json;
using StackExchange.Redis;

namespace CollabCanvas.Api.Comments;

/// Doc-level comments (post-auth feature). They are NOT document
/// objects — no LWW, no journal, no undo: a comment thread is
/// conversation metadata, not canvas state. Keys:
///   doc:{id}:comments   hash cid → {"a":author,"t":text,"ts":unix}
/// Realtime: the hub stores then broadcasts "comment" to the doc
/// group; reconnects refetch the list over REST (small, unordered
/// by design — sorted client-side by ts).
public sealed class DocCommentStore(IConnectionMultiplexer redis)
{
    private IDatabase Db => redis.GetDatabase();
    private static string CKey(string docId) => $"doc:{docId}:comments";
    public const int MaxPerDoc = 500;
    public const int MaxLen = 1000;

    public sealed record Rec(string Id, string Author, string Text, long Ts);

    public async Task<Rec[]> ListAsync(string docId)
    {
        var h = await Db.HashGetAllAsync(CKey(docId));
        var out_ = new List<Rec>(h.Length);
        foreach (var e in h)
        {
            var j = JsonDocument.Parse((string)e.Value!);
            out_.Add(new Rec(e.Name!,
                j.RootElement.GetProperty("a").GetString() ?? "?",
                j.RootElement.GetProperty("t").GetString() ?? "",
                j.RootElement.GetProperty("ts").GetInt64()));
        }
        return out_.OrderBy(c => c.Ts).ToArray();
    }

    /// <returns>null when the doc already sits at the comment cap.</returns>
    public async Task<Rec?> AddAsync(string docId, string author, string text)
    {
        if (await Db.HashLengthAsync(CKey(docId)) >= MaxPerDoc) return null;
        var id = Convert.ToBase64String(
            System.Security.Cryptography.RandomNumberGenerator.GetBytes(6))
            .Replace('+', '-').Replace('/', '_');
        var rec = new Rec(id, author, text,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        await Db.HashSetAsync(CKey(docId), id,
            JsonSerializer.Serialize(
                new { a = rec.Author, t = rec.Text, ts = rec.Ts }));
        return rec;
    }

    /// <summary>Author or admin+ may delete — enforced by the caller
    /// (the store returns false only when the cid is unknown).</summary>
    public async Task<Rec?> GetAsync(string docId, string cid)
    {
        var v = await Db.HashGetAsync(CKey(docId), cid);
        if (v.IsNullOrEmpty) return null;
        var j = JsonDocument.Parse(v.ToString()!);
        return new Rec(cid,
            j.RootElement.GetProperty("a").GetString() ?? "?",
            j.RootElement.GetProperty("t").GetString() ?? "",
            j.RootElement.GetProperty("ts").GetInt64());
    }

    public Task RemoveAsync(string docId, string cid) =>
        Db.HashDeleteAsync(CKey(docId), cid);
}
