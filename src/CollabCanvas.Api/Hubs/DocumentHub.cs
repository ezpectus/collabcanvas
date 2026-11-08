using CollabCanvas.Core.Protocol;
using Microsoft.AspNetCore.SignalR;

namespace CollabCanvas.Api.Hubs;

/// <summary>
/// Document room endpoint. T-2 stub: join/leave group bookkeeping is
/// real; ops are acked as not-implemented — an honest answer a client
/// can render, instead of a silent drop or a fake success. T-4 wires
/// the room + seq allocator, T-5 the journal, T-7 presence.
/// </summary>
public sealed class DocumentHub : Hub
{
    public async Task<JoinResult> JoinDocument(JoinDocumentRequest req)
    {
        await Groups.AddToGroupAsync(Context.ConnectionId, req.DocId);
        // No room state yet (T-4/T-5) — join answers "fresh doc, nothing to replay".
        return new JoinResult(req.DocId, LastSeq: 0, Snapshot: null, SnapshotSeq: 0, Ops: []);
    }

    public Task LeaveDocument(string docId) =>
        Groups.RemoveFromGroupAsync(Context.ConnectionId, docId);

    public Task<OpAck> SubmitOp(OpSubmit op) =>
        Task.FromResult(new OpAck(op.ClientSeq, Seq: 0, Accepted: false, Reason: "ops-not-implemented-T4"));

    public Task Presence(PresenceUpdate update) =>
        Clients.OthersInGroup(update.DocId)
            .SendAsync("presence", new PresenceBroadcast(update.ClientId, update));
}
