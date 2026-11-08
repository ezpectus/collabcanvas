using System.Text.Json;
using CollabCanvas.Core.Presence;
using CollabCanvas.Core.Protocol;
using CollabCanvas.Core.Room;

namespace CollabCanvas.Tests;

// T-7 gate: ephemeral presence — replace-per-client, TTL expiry,
// rate-limited fanout. All tested on the pure tracker + room, no WS.
public class PresenceTests
{
    private static readonly DateTimeOffset T0 = new(2026, 11, 8, 0, 0, 0, TimeSpan.Zero);

    private static PresenceUpdate Update(string client) =>
        new("doc", client, JsonDocument.Parse("""{"x":1,"y":2}""").RootElement,
            [], "#fff");

    [Fact]
    public void Update_ReplacesPrevious_PerClient()
    {
        var t = new PresenceTracker();
        t.Update("A", Update("A"), T0);
        t.Update("A", Update("A"), T0.AddSeconds(1)); // moved
        t.Update("B", Update("B"), T0);

        var current = t.Current();
        Assert.Equal(2, current.Count); // one entry per client, latest wins
    }

    [Fact]
    public void Update_RateLimitsFanout_ButStoresLatest()
    {
        var t = new PresenceTracker();
        Assert.True(t.Update("A", Update("A"), T0));                    // first always forwards
        Assert.False(t.Update("A", Update("A"), T0.AddMilliseconds(50))); // spam dropped from fanout
        Assert.True(t.Update("A", Update("A"),
            T0.AddMilliseconds(150)));                                   // past MinInterval — flows again

        // The dropped update still refreshed the stored value + TTL.
        var dead = t.Expire(T0.AddMilliseconds(150) + PresenceTracker.Ttl - TimeSpan.FromMilliseconds(1));
        Assert.Empty(dead); // lastSeen is t=150ms, not t=0
    }

    [Fact]
    public void Expire_SilencePastTtl_ReturnsGone()
    {
        var t = new PresenceTracker();
        t.Update("A", Update("A"), T0);
        t.Update("B", Update("B"), T0.AddSeconds(9));

        var dead = t.Expire(T0.AddSeconds(11));
        Assert.Equal(["A"], dead);      // B still has 1s of TTL left
        Assert.Single(t.Current());     // A is gone from the snapshot too
    }

    [Fact]
    public void Heartbeat_IsJustAnUpdate_RefreshesTtl()
    {
        var t = new PresenceTracker();
        t.Update("A", Update("A"), T0);
        // Client sends the same payload every 2s — no separate message
        // type needed, TTL just slides.
        for (var i = 1; i <= 6; i++)
            t.Update("A", Update("A"), T0.AddSeconds(i * 2));

        Assert.Empty(t.Expire(T0.AddSeconds(12) + PresenceTracker.Ttl - TimeSpan.FromSeconds(1)));
        Assert.Equal(["A"], t.Expire(T0.AddSeconds(12) + PresenceTracker.Ttl + TimeSpan.FromSeconds(1)));
    }

    [Fact]
    public void Disconnect_UntracksPresence_WithoutWaitingForTtl()
    {
        var mgr = new RoomManager();
        var room = mgr.GetOrCreate("doc");
        mgr.TrackConnection("conn-1", "doc", "A");
        room.Presence.Update("A", Update("A"), T0);

        var left = mgr.UntrackConnection("conn-1");
        Assert.Equal([("doc", "A")], left);
        Assert.Empty(room.Presence.Current());
    }
}
