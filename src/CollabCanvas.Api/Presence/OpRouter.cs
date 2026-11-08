using CollabCanvas.Core.Protocol;
using CollabCanvas.Core.Room;
using Microsoft.AspNetCore.SignalR;

namespace CollabCanvas.Api.Presence;

/// <summary>
/// Transport ↔ hub glue (T-10), a singleton because hub instances are
/// transient:
/// - transport.OnSubmit (owner inbox): apply to local Room, then
///   broadcast — INCLUDING dedup hits: re-broadcasting the original
///   is harmless (clients drop seq ≤ last) and it un-stalls the
///   retrying client's pending.
/// - transport.OnBroadcast (every instance): relay to the SignalR
///   group — the single uniform fanout path, owner or not.
/// </summary>
public sealed class OpRouter(
    RoomManager rooms,
    IRoomTransport transport,
    IHubContext<Hubs.DocumentHub> hub) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        transport.OnSubmit += submit =>
        {
            var room = rooms.GetOrCreate(submit.DocId);
            var r = room.Submit(submit);
            _ = transport.BroadcastAsync(r.Broadcast);
        };
        transport.OnBroadcast += op =>
            _ = hub.Clients.Group(op.DocId).SendAsync("op", op);
        transport.OnPresence += p =>
            _ = hub.Clients.Group(p.Update.DocId).SendAsync("presence", p);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) =>
        Task.CompletedTask;
}
