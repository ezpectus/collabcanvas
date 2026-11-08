using CollabCanvas.Api.Hubs;
using CollabCanvas.Core.Protocol;
using CollabCanvas.Core.Room;
using Microsoft.AspNetCore.SignalR;

namespace CollabCanvas.Api.Presence;

/// <summary>
/// TTL sweeper (T-7): every 2s asks each room which clients went
/// silent and announces "presence-left" to their groups. This is the
/// ONLY path that cleans up silent-but-connected clients — a frozen
/// tab that stops sending still holds a WS, so disconnect alone
/// can't catch it.
///
/// Worst-case ghost lifetime = TTL (10s) + sweep interval (2s).
/// Presence is lossy by design — a missed left-announce just means
/// a stale cursor a little longer, never corrupt state.
/// </summary>
public sealed class PresenceSweeper(
    RoomManager rooms,
    IHubContext<DocumentHub> hub,
    ILogger<PresenceSweeper> log) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(2);

    protected override async Task ExecuteAsync(CancellationToken stop)
    {
        using var timer = new PeriodicTimer(Interval);
        while (await timer.WaitForNextTickAsync(stop))
        {
            var now = DateTimeOffset.UtcNow;
            foreach (var room in rooms.Rooms)
            {
                string[] dead;
                try { dead = room.Presence.Expire(now); }
                catch (Exception e) { log.LogError(e, "presence sweep failed for {Doc}", room.DocId); continue; }

                foreach (var clientId in dead)
                    await hub.Clients.Group(room.DocId)
                        .SendAsync("presence-left",
                            new PresenceLeft(room.DocId, clientId), stop);
            }
        }
    }
}
