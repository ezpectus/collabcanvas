using System.Text.Json;
using CollabCanvas.Core.Journal;
using CollabCanvas.Core.Model;
using CollabCanvas.Core.Protocol;

namespace CollabCanvas.Core.Room;

/// <summary>
/// One document room — THE ordering point (T-4) with durable
/// persistence (T-5).
///
/// All ops funnel through <see cref="Submit"/> under a lock: dedup by
/// (clientId, clientSeq) → assign server seq → apply → append journal.
/// The journal append happens INSIDE the same lock, so a snapshot or a
/// replay can never interleave with a half-applied op.
///
/// Recovery (constructor): load snapshot → restore registers at
/// snapSeq → replay journal tail (seq &gt; snapSeq) → rebuild dedup
/// state. Rebuild is free: every journaled op carries clientId+clientSeq,
/// so _ackIndex/_lastClientSeq come back exactly as they were — a
/// client retrying across a server restart still gets its original seq.
/// </summary>
public sealed class Room
{
    /// <summary>Snapshot trigger: every N applied ops. Time-based
    /// trigger is deliberately absent — a doc with low traffic costs a
    /// journal replay bounded by MAXLEN anyway.</summary>
    public const int SnapshotEveryOps = 100;

    private readonly object _gate = new();
    private readonly Document _doc = new();
    private readonly IOpJournal _store;
    private readonly Dictionary<long, OpBroadcast> _ops = new(); // seq → op, this room's lifetime
    private readonly Dictionary<string, long> _lastClientSeq = new();
    private readonly Dictionary<(string ClientId, long ClientSeq), long> _ackIndex = new();
    private long _snapSeq;
    private int _opsSinceSnap;

    public Room(string docId) : this(docId, new InMemoryOpJournal()) { }

    public Room(string docId, IOpJournal store)
    {
        DocId = docId;
        _store = store;

        if (store.LoadSnapshot() is { } snap)
        {
            _doc.Restore(snap.Json, snap.Seq);
            _snapSeq = snap.Seq;
        }
        // Replay EVERYTHING the store still holds, not just seq>snapSeq:
        // ops <= snapSeq are LWW no-ops against the restored registers,
        // but a late joiner may legitimately ask for them (its lastSeq
        // can sit between the journal base and snapSeq).
        foreach (var op in store.ReadSince(store.FirstSeq - 1).OrderBy(o => o.Seq))
            Replay(op);
    }

    public string DocId { get; }
    public long LastSeq => _doc.LastSeq;

    /// <summary>Last submit/join — the eviction sweep keys on this,
    /// not on op count: an idle room with live readers stays.</summary>
    public DateTimeOffset LastActivity { get; private set; } = DateTimeOffset.UtcNow;

    /// <summary>Ephemeral cursors/selections — deliberately NOT
    /// journaled: presence dies with the room (T-7).</summary>
    public Presence.PresenceTracker Presence { get; } = new();

    /// <summary>Submit result: the op's server seq plus whether it was
    /// freshly applied (false = dedup hit — client retried).</summary>
    public sealed record SubmitResult(OpBroadcast Broadcast, bool IsNew);

    /// <summary>Dedup → seq → apply → journal. Retried submits return
    /// the ORIGINAL seq without re-applying — the journal holds it.
    /// Honest edge: if the journal truncated AND the room restarted,
    /// the dedup index is gone — an ancient retry applies as a new op
    /// (harmless payload-wise: same write, new seq).</summary>
    public SubmitResult Submit(OpSubmit op)
    {
        lock (_gate)
        {
            var key = (op.ClientId, op.ClientSeq);
            if (_ackIndex.TryGetValue(key, out var dupSeq) && _ops.TryGetValue(dupSeq, out var dup))
                return new SubmitResult(dup, IsNew: false);

            _lastClientSeq[op.ClientId] = Math.Max(
                _lastClientSeq.GetValueOrDefault(op.ClientId), op.ClientSeq);

            var seq = _doc.LastSeq + 1; // room assigns — clients never touch seq
            var broadcast = new OpBroadcast(
                op.DocId, seq, op.ClientId, op.ClientSeq, op.Type, op.Payload);

            _doc.Apply(broadcast);
            _store.Append(broadcast); // durable before it can be broadcast
            _ops[seq] = broadcast;
            _ackIndex[key] = seq;

            if (++_opsSinceSnap >= SnapshotEveryOps)
            {
                _snapSeq = seq;
                _store.WriteSnapshot(seq, _doc.Snapshot());
                _opsSinceSnap = 0;
            }
            LastActivity = DateTimeOffset.UtcNow;
            return new SubmitResult(broadcast, IsNew: true);
        }
    }

    /// <summary>Join answer: ops the client missed — or a snapshot +
    /// tail when lastSeq fell below the journal base (truncated) or is
    /// in the future (client ahead of server, e.g. server lost data).
    /// Snapshot case ships ops since snapSeq, not since lastSeq — the
    /// snapshot covers everything below snapSeq.</summary>
    public JoinResult Join(string clientId, long lastSeq)
    {
        lock (_gate)
        {
            LastActivity = DateTimeOffset.UtcNow;
            // store.FirstSeq is read live — the journal may have been
            // trimmed since this room booted.
            if (lastSeq >= _store.FirstSeq && lastSeq <= _doc.LastSeq)
            {
                var tail = Tail(lastSeq);
                return new JoinResult(DocId, _doc.LastSeq, null, _snapSeq, tail);
            }

            var snap = JsonDocument.Parse(_doc.Snapshot()).RootElement;
            return new JoinResult(DocId, _doc.LastSeq, snap, _snapSeq, Tail(_snapSeq));
        }
    }

    private OpBroadcast[] Tail(long sinceSeq) =>
        _ops.Values.Where(o => o.Seq > sinceSeq).OrderBy(o => o.Seq).ToArray();

    private void Replay(OpBroadcast op)
    {
        _doc.Apply(op);
        _ops[op.Seq] = op;
        _ackIndex[(op.ClientId, op.ClientSeq)] = op.Seq;
        _lastClientSeq[op.ClientId] = Math.Max(
            _lastClientSeq.GetValueOrDefault(op.ClientId), op.ClientSeq);
    }

    /// <summary>Read-only snapshot for a late-joining client or the
    /// snapshot writer. Deterministic — same writes, same bytes.</summary>
    public string Snapshot()
    {
        lock (_gate) { return _doc.Snapshot(); }
    }
}

/// <summary>docId → Room. ConcurrentDictionary get-or-add is the only
/// cross-room coordination; ordering inside a room is per-room lock.
/// The journal factory decides durability per doc — in-memory for
/// tests, Redis Streams in production.</summary>
public sealed class RoomManager(IOpJournalFactory? journalFactory = null)
{
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, Room> _rooms = new();
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, (string DocId, string ClientId)> _connections = new();
    private readonly IOpJournalFactory _journals = journalFactory ?? new InMemoryOpJournalFactory();

    public Room GetOrCreate(string docId) =>
        _rooms.GetOrAdd(docId, id => new Room(id, _journals.ForDoc(id)));

    /// <summary>Live rooms — the presence sweeper iterates these.</summary>
    public IEnumerable<Room> Rooms => _rooms.Values;

    /// <summary>connection → (doc, client) so a dropped socket can
    /// kill its cursor without waiting for TTL.</summary>
    public void TrackConnection(string connectionId, string docId, string clientId) =>
        _connections[connectionId] = (docId, clientId);

    /// <summary>Socket died: drop presence for every doc it joined.
    /// Returns the (docId, clientId) pairs to announce as left.</summary>
    public (string DocId, string ClientId)[] UntrackConnection(string connectionId)
    {
        if (!_connections.TryRemove(connectionId, out var c)) return [];
        GetOrCreate(c.DocId).Presence.Remove(c.ClientId);
        return [c];
    }

    /// <summary>Evict rooms idle past <paramref name="idleFor"/> with
    /// no live presence — eviction is SAFE: the room reloads from
    /// snapshot+journal on next contact (T-5 recovery is the exit
    /// strategy by design). Returns evicted docIds.</summary>
    public string[] EvictIdle(TimeSpan idleFor, DateTimeOffset now)
    {
        var evicted = new List<string>();
        foreach (var (docId, room) in _rooms)
        {
            if (now - room.LastActivity < idleFor) continue;
            if (room.Presence.Current().Count > 0) continue; // someone still around
            if (_rooms.TryRemove(docId, out _)) evicted.Add(docId);
        }
        return [.. evicted];
    }
}
