using CollabCanvas.Core.Protocol;
using CollabCanvas.Core.Room;
using Microsoft.AspNetCore.SignalR;

namespace CollabCanvas.Api.Hubs;

/// <summary>
/// Document room endpoint — thin SignalR adapter over <see cref="Room"/>.
/// The room owns ALL ordering/dedup/apply (pure, unit-testable); the
/// hub only moves messages: join → ops-since, submit → ack to author +
/// broadcast to the group. Presence stays ephemeral fanout (T-7 adds
/// TTL/throttle).
/// </summary>
public sealed class DocumentHub(RoomManager rooms) : Hub
{
    public async Task<JoinResult> JoinDocument(JoinDocumentRequest req)
    {
        var room = rooms.GetOrCreate(req.DocId);
        await Groups.AddToGroupAsync(Context.ConnectionId, req.DocId);
        return room.Join(req.ClientId, req.LastSeq);
    }

    public Task LeaveDocument(string docId) =>
        Groups.RemoveFromGroupAsync(Context.ConnectionId, docId);

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

    public Task Presence(PresenceUpdate update) =>
        Clients.OthersInGroup(update.DocId)
            .SendAsync("presence", new PresenceBroadcast(update.ClientId, update));
}
