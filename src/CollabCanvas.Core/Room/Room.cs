using System.Text.Json;
using CollabCanvas.Core.Model;
using CollabCanvas.Core.Protocol;

namespace CollabCanvas.Core.Room;

/// <summary>
/// One document room — THE ordering point (T-4).
///
/// All ops for a doc funnel through <see cref="Submit"/> under a
/// lock: dedup by (clientId, clientSeq) → assign server seq → apply
/// to <see cref="Document"/> → append in-memory journal. Whoever
/// gets the lock first gets the lower seq — that IS "last write
/// wins" made concrete.
///
/// Journal is in-memory only (persistence = T-5): restart loses
/// everything, by design for now.
/// </summary>
public sealed class Room
{
    private readonly object _gate = new();
    private readonly Document _doc = new();
    private readonly List<OpBroadcast> _journal = new();
    private readonly Dictionary<string, long> _lastClientSeq = new();
    private readonly Dictionary<(string ClientId, long ClientSeq), long> _ackIndex = new();

    public Room(string docId) => DocId = docId;

    public string DocId { get; }
    public long LastSeq => _doc.LastSeq;

    /// <summary>Submit result: the op's server seq plus whether it was
    /// freshly applied (false = dedup hit — client retried).</summary>
    public sealed record SubmitResult(OpBroadcast Broadcast, bool IsNew);

    /// <summary>Dedup → seq → apply → journal. Retried submits return
    /// the ORIGINAL seq without re-applying — the journal holds it.</summary>
    public SubmitResult Submit(OpSubmit op)
    {
        lock (_gate)
        {
            var key = (op.ClientId, op.ClientSeq);
            if (_ackIndex.TryGetValue(key, out var dupSeq))
            {
                var original = _journal[(int)dupSeq - 1]; // journal is seq-ordered, 1-based
                return new SubmitResult(original, IsNew: false);
            }

            // Client-side monotonic watermark. A clientSeq LOWER than
            // the last seen without being in _ackIndex means the op
            // was submitted before its predecessor — accept anyway
            // (ordering within a client is the client's job) but keep
            // the watermark at max.
            _lastClientSeq[op.ClientId] = Math.Max(
                _lastClientSeq.GetValueOrDefault(op.ClientId), op.ClientSeq);

            var seq = _doc.LastSeq + 1; // room assigns — clients never touch seq
            var broadcast = new OpBroadcast(
                op.DocId, seq, op.ClientId, op.ClientSeq, op.Type, op.Payload);

            _doc.Apply(broadcast);
            _journal.Add(broadcast);
            _ackIndex[key] = seq;
            return new SubmitResult(broadcast, IsNew: true);
        }
    }

    /// <summary>Join answer: ops the client missed. MVP sends the
    /// journal tail (small); snapshots arrive with persistence (T-5)
    /// where the journal may be truncated.</summary>
    public JoinResult Join(string clientId, long lastSeq)
    {
        lock (_gate)
        {
            var since = _journal.Where(o => o.Seq > lastSeq).ToArray();
            return new JoinResult(DocId, _doc.LastSeq, null, 0, since);
        }
    }

    /// <summary>Read-only snapshot for a late-joining client or T-5
    /// persistence. Deterministic — same writes, same bytes.</summary>
    public string Snapshot()
    {
        lock (_gate) { return _doc.Snapshot(); }
    }
}

/// <summary>docId → Room. ConcurrentDictionary get-or-add is the only
/// cross-room coordination; ordering inside a room is per-room lock.</summary>
public sealed class RoomManager
{
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, Room> _rooms = new();

    public Room GetOrCreate(string docId) =>
        _rooms.GetOrAdd(docId, id => new Room(id));
}
