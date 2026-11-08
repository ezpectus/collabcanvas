using CollabCanvas.Core.Protocol;
using CollabCanvas.Core.Room;
using Microsoft.AspNetCore.SignalR;

namespace CollabCanvas.Api.Hubs;

/// <summary>
/// Document room endpoint — thin SignalR adapter over <see cref="Room"/>.
/// The room owns ALL ordering/dedup/apply (pure, unit-testable); the
/// hub only moves messages: join → ops-since + presence snapshot,
/// submit → ack to author + broadcast to the group.
///
/// Presence (T-7): the tracker's Update() doubles as heartbeat and
/// rate-limiter — it answers "fan out now?" while always refreshing
/// TTL. Dead cursors are announced by the sweeper (TTL) or eagerly on
/// socket disconnect.
/// </summary>
public sealed class DocumentHub(RoomManager rooms) : Hub
{
    public async Task<JoinResult> JoinDocument(JoinDocumentRequest req)
    {
        var room = rooms.GetOrCreate(req.DocId);
        await Groups.AddToGroupAsync(Context.ConnectionId, req.DocId);
        rooms.TrackConnection(Context.ConnectionId, req.DocId, req.ClientId);
        var join = room.Join(req.ClientId, req.LastSeq);

        // Late joiner sees everyone else's cursors — presence is
        // ephemeral, so it goes outside the JoinResult ops contract.
        await Clients.Caller.SendAsync("presence-state",
            room.Presence.Current());
        return join;
    }

    public async Task LeaveDocument(string docId)
    {
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, docId);
    }

    public async Task<OpAck> SubmitOp(OpSubmit op)
    {
        var room = rooms.GetOrCreate(op.DocId);
        var result = room.Submit(op);

        // Broadcast to EVERYONE incl. author — the author reconciles
        // its optimistic apply against the echoed seq (T-9).
        await Clients.Group(op.DocId).SendAsync("op", result.Broadcast);

        return new OpAck(op.ClientSeq, result.Broadcast.Seq,
            Accepted: true, Reason: result.IsNew ? null : "duplicate");
    }

    public async Task Presence(PresenceUpdate update)
    {
        var room = rooms.GetOrCreate(update.DocId);
        // Tracker stores every update (join snapshot stays fresh) and
        // rate-limits the fanout — a spammy client can't flood the room.
        if (room.Presence.Update(update.ClientId, update, DateTimeOffset.UtcNow))
            await Clients.OthersInGroup(update.DocId)
                .SendAsync("presence", new PresenceBroadcast(update.ClientId, update));
    }

    /// <summary>Socket died — kill the cursor now instead of letting it
    /// ghost for the full TTL.</summary>
    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        foreach (var (docId, clientId) in rooms.UntrackConnection(Context.ConnectionId))
            await Clients.Group(docId)
                .SendAsync("presence-left", new PresenceLeft(docId, clientId));
        await base.OnDisconnectedAsync(exception);
    }
}
