using CollabCanvas.Core.Protocol;

namespace CollabCanvas.Core.Journal;

/// <summary>
/// Durable op journal + snapshots (T-5). Sync API on purpose: the
/// room's ordering point is a lock — every write is already
/// serialized, so async would only add lock-around-await gymnastics.
///
/// Contract:
/// - <see cref="Append"/> is called AFTER in-memory apply, BEFORE
///   broadcast — journal is the source of truth on restart.
/// - <see cref="ReadSince"/> returns ops with seq &gt; since, ordered.
/// - <see cref="FirstSeq"/> = earliest seq still present (streams get
///   truncated by MAXLEN). Joins below it get a snapshot instead.
/// </summary>
public interface IOpJournal
{
    long FirstSeq { get; }
    void Append(OpBroadcast op);
    IReadOnlyList<OpBroadcast> ReadSince(long seq);
    /// <summary>T-24: newest n ops, ascending. For the history view —
    ///   bounded read that doesn't scan the whole stream.</summary>
    IReadOnlyList<OpBroadcast> Tail(int n);
    RoomSnapshot? LoadSnapshot();
    void WriteSnapshot(long seq, string json);
}

public sealed record RoomSnapshot(long Seq, string Json);

/// <summary>docId → journal. Implementations live per-store.</summary>
public interface IOpJournalFactory
{
    IOpJournal ForDoc(string docId);
}

/// <summary>
/// In-memory journal — default for tests and for Redis-down degraded
/// mode. Optional maxLen simulates stream truncation: old entries are
/// dropped, which is exactly what MAXLEN does to a Redis Stream.
/// </summary>
public sealed class InMemoryOpJournal(int? maxLen = null) : IOpJournal
{
    private readonly List<OpBroadcast> _ops = new();
    private RoomSnapshot? _snap;

    public long FirstSeq =>
        _ops.Count > 0 ? _ops[0].Seq
        : _snap is { } s ? s.Seq + 1
        : 1;

    public void Append(OpBroadcast op)
    {
        _ops.Add(op);
        if (maxLen is { } n)
            while (_ops.Count > n) _ops.RemoveAt(0);
    }

    public IReadOnlyList<OpBroadcast> ReadSince(long seq) =>
        _ops.Where(o => o.Seq > seq).ToArray();

    public IReadOnlyList<OpBroadcast> Tail(int n) =>
        _ops.TakeLast(n).ToArray();

    public RoomSnapshot? LoadSnapshot() => _snap;

    public void WriteSnapshot(long seq, string json) => _snap = new(seq, json);
}

public sealed class InMemoryOpJournalFactory(int? maxLen = null) : IOpJournalFactory
{
    private readonly Dictionary<string, InMemoryOpJournal> _journals = new();
    private readonly object _gate = new();

    public IOpJournal ForDoc(string docId)
    {
        lock (_gate)
            return _journals.TryGetValue(docId, out var j)
                ? j
                : _journals[docId] = new InMemoryOpJournal(maxLen);
    }
}
