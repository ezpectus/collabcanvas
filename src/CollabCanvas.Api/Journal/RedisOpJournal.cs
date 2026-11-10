using System.Text.Json;
using CollabCanvas.Core.Journal;
using CollabCanvas.Core.Protocol;
using StackExchange.Redis;

namespace CollabCanvas.Api.Journal;

/// <summary>
/// Redis Streams journal (T-5): XADD per op into
/// doc:{id}:ops (MAXLEN ~10000 approximate trim), snapshot blob in
/// doc:{id}:snap as {seq,json}.
///
/// Stream entry ids are Redis-assigned (ms-seq), NOT our op seq —
/// ReadSince deserializes and filters by OpBroadcast.Seq, and FirstSeq
/// is the seq of the oldest surviving entry. Ordering by stream id =
/// append order = seq order, so no sort needed.
///
/// Failure mode — FAIL-OPEN by design: a Redis outage degrades the
/// room to in-memory persistence (ops still apply/broadcast, restart
/// loses them — the exact pre-T-5 behavior). Alternatives considered:
/// failing Submit would let a Redis blip freeze all editing; queuing
/// appends would reorder journal vs in-memory apply. /health already
/// reports "degraded" so the mode is observable.
/// </summary>
public sealed class RedisOpJournal(IConnectionMultiplexer mux, string docId) : IOpJournal
{
    public const int MaxStreamLen = 10_000;

    private IDatabase Db => mux.GetDatabase();
    private string OpsKey => $"doc:{docId}:ops";
    private string SnapKey => $"doc:{docId}:snap";

    // Read live on every call — MAXLEN trim moves the base forward at
    // any time; a cached value would silently strand old joiners.
    public long FirstSeq =>
        ReadAll().FirstOrDefault()?.Seq
        ?? LoadSnapshot()?.Seq + 1
        ?? 1;

    public void Append(OpBroadcast op) => Try(() =>
        Db.StreamAdd(OpsKey,
            [new NameValueEntry("op", JsonSerializer.Serialize(op))],
            maxLength: MaxStreamLen, useApproximateMaxLength: true));

    public IReadOnlyList<OpBroadcast> ReadSince(long seq) =>
        ReadAll().Where(o => o.Seq > seq).ToArray();

    public IReadOnlyList<OpBroadcast> Tail(int n) => Try(() =>
        Db.StreamRange(OpsKey, "-", "+", count: n,
                messageOrder: Order.Descending)
            .Select(e => JsonSerializer.Deserialize<OpBroadcast>(
                e["op"].ToString())!)
            .Reverse().ToArray()) ?? [];

    public RoomSnapshot? LoadSnapshot() => Try(() =>
    {
        var v = Db.StringGet(SnapKey);
        if (v.IsNullOrEmpty) return null;
        var el = JsonDocument.Parse(v.ToString()).RootElement;
        return new RoomSnapshot(el.GetProperty("seq").GetInt64(),
            el.GetProperty("json").GetString()!);
    });

    public void WriteSnapshot(long seq, string json) => Try(() =>
    {
        Db.StringSet(SnapKey, JsonSerializer.Serialize(new { seq, json }));
        SweepBlobs(json);
    });

    /// Blob GC piggybacked on snapshot writes: the snapshot IS the doc
    /// truth, so a blob no object references is bytes nobody can draw.
    /// The grace window covers the upload → Create-op gap — a blob
    /// younger than <see cref="BlobGraceSeconds"/> is spared even when
    /// unreferenced (its Create may still be in flight).
    public const int BlobGraceSeconds = 120;
    private void SweepBlobs(string snapshotJson)
    {
        var referenced = new HashSet<string>();
        foreach (var o in JsonDocument.Parse(snapshotJson).RootElement
            .EnumerateArray())
            if (o.TryGetProperty("Props", out var p) &&
                p.TryGetProperty("src", out var s) &&
                s.ValueKind == JsonValueKind.String)
                referenced.Add(s.GetString()!);
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var db = Db;
        foreach (var b in db.SetMembers($"doc:{docId}:blobs"))
        {
            var id = b.ToString();
            if (referenced.Contains(id)) continue;
            var ts = db.HashGet($"blob:{id}:meta", "ts");
            // No ts = pre-grace blob — treated as old enough to collect.
            if (long.TryParse(ts.ToString(), out var t) &&
                now - t < BlobGraceSeconds) continue;
            db.KeyDelete($"blob:{id}");
            db.KeyDelete($"blob:{id}:meta");
            db.SetRemove($"doc:{docId}:blobs", id);
        }
    }

    private OpBroadcast[] ReadAll() => Try(() =>
        Db.StreamRange(OpsKey).Select(e =>
            JsonSerializer.Deserialize<OpBroadcast>(e["op"].ToString())!)
          .ToArray()) ?? [];

    /// <summary>Degrade to no-op on any Redis-side failure — see class
    /// doc for why this is deliberate, not lazy.</summary>
    private static void Try(Action act)
    {
        try { act(); }
        catch (Exception e) when (e is RedisException or RedisTimeoutException
            or RedisConnectionException or System.Text.Json.JsonException) { }
    }

    private static T? Try<T>(Func<T?> f)
    {
        try { return f(); }
        catch (Exception e) when (e is RedisException or RedisTimeoutException
            or RedisConnectionException or System.Text.Json.JsonException)
        { return default; }
    }
}

public sealed class RedisOpJournalFactory(IConnectionMultiplexer mux) : IOpJournalFactory
{
    public IOpJournal ForDoc(string docId) => new RedisOpJournal(mux, docId);
}
