using CollabCanvas.Core.Journal;
using CollabCanvas.Core.Protocol;
using CollabCanvas.Core.Room;
using Microsoft.AspNetCore.SignalR;

namespace CollabCanvas.Api.Hubs;

/// <summary>
/// Document room endpoint — thin SignalR adapter (T-10 wiring).
/// Ordering/dedup/apply live in the Room on the OWNING instance;
/// this hub only routes:
/// - submit: owner → Room.Submit → transport.Broadcast (OpRouter
///   fans it to all groups incl. this one); non-owner → publish to
///   the owner's inbox, ack "forwarded" (the echo carries real seq).
/// - join: owner → Room.Join; non-owner → built straight from the
///   journal — ops/snapshot are in Redis, no room needed locally.
/// </summary>
public sealed class DocumentHub(
    RoomManager rooms,
    IRoomTransport transport,
    IOpJournalFactory journals,
    OpRateLimiter opLimit,
    StackExchange.Redis.IConnectionMultiplexer redis) : Hub
{
    public async Task<JoinResult> JoinDocument(JoinDocumentRequest req)
    {
        var room = rooms.GetOrCreate(req.DocId);
        // T-19: index the doc for the /docs listing. Fire-and-forget —
        // a Redis outage degrades discovery, never the join itself.
        _ = redis.GetDatabase().SetAddAsync("docs", req.DocId);
        await Groups.AddToGroupAsync(Context.ConnectionId, req.DocId);
        rooms.TrackConnection(Context.ConnectionId, req.DocId, req.ClientId);

        if (transport.Owns(req.DocId))
        {
            var join = room.Join(req.ClientId, req.LastSeq);
            await Clients.Caller.SendAsync("presence-state", room.Presence.Current());
            return join;
        }

        // Non-owner: answer from the durable journal directly.
        var store = journals.ForDoc(req.DocId);
        var snap = store.LoadSnapshot();
        if (req.LastSeq >= store.FirstSeq)
        {
            var tail = store.ReadSince(req.LastSeq);
            var lastSeq = Math.Max(snap?.Seq ?? 0,
                tail.Count > 0 ? tail[^1].Seq : 0);
            return new JoinResult(req.DocId, lastSeq, null, snap?.Seq ?? 0, tail);
        }
        var sinceSnap = store.ReadSince(snap?.Seq ?? 0);
        return new JoinResult(req.DocId,
            Math.Max(snap?.Seq ?? 0, sinceSnap.Count > 0 ? sinceSnap[^1].Seq : 0),
            snap is null ? null : System.Text.Json.JsonDocument.Parse(snap.Json).RootElement,
            snap?.Seq ?? 0, sinceSnap);
    }

    public async Task LeaveDocument(string docId) =>
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, docId);

    public async Task<OpAck> SubmitOp(OpSubmit op)
    {
        // T-13: validate + rate-limit BEFORE the room — a malformed op
        // must never reach the journal, and one scripted client must
        // never mint ops at network speed.
        if (!opLimit.Allow(Context.ConnectionId, DateTimeOffset.UtcNow))
            return new OpAck(op.ClientSeq, -1, Accepted: false, Reason: "rate-limited");
        if (OpValidator.Validate(op) is { } why)
            return new OpAck(op.ClientSeq, -1, Accepted: false, Reason: $"invalid: {why}");

        if (transport.Owns(op.DocId))
        {
            var room = rooms.GetOrCreate(op.DocId);
            var result = room.Submit(op);
            // Fanout goes through the transport (OpRouter → group) so
            // multi-instance behaves identically to single-instance.
            await transport.BroadcastAsync(result.Broadcast);
            return new OpAck(op.ClientSeq, result.Broadcast.Seq,
                Accepted: true, Reason: result.IsNew ? null : "duplicate");
        }

        await transport.SubmitRemoteAsync(op);
        // seq unknown until the owner sequences it — the echo
        // broadcast carries it; -1 = "forwarded, watch the stream".
        return new OpAck(op.ClientSeq, -1, Accepted: true, Reason: "forwarded");
    }

    public async Task Presence(PresenceUpdate update)
    {
        var room = rooms.GetOrCreate(update.DocId);
        // Tracker stores every update (join snapshot stays fresh) and
        // rate-limits the fanout — a spammy client can't flood the room.
        if (room.Presence.Update(update.ClientId, update, DateTimeOffset.UtcNow))
            // Goes through the transport so OTHER instances see it too
            // (T-12). The client filters its own clientId, so group
            // fanout instead of OthersInGroup is fine.
            await transport.PublishPresenceAsync(
                new PresenceBroadcast(update.ClientId, update));
    }

    /// <summary>Socket died — kill the cursor now instead of letting it
    /// ghost for the full TTL.</summary>
    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        opLimit.Drop(Context.ConnectionId);
        foreach (var (docId, clientId) in rooms.UntrackConnection(Context.ConnectionId))
            await Clients.Group(docId)
                .SendAsync("presence-left", new PresenceLeft(docId, clientId));
        await base.OnDisconnectedAsync(exception);
    }
}
