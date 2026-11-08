using System.Text.Json;
using CollabCanvas.Core.Protocol;
using CollabCanvas.Core.Room;

namespace CollabCanvas.Tests;

// T-4 gate: the room is the ordering point. Dedup on client retry,
// server-assigned seq, join catch-up — all tested WITHOUT SignalR
// because the room is pure logic.
public class RoomTests
{
    private static OpSubmit Submit(string client, long cseq, OpType type, string payload) =>
        new("doc", client, cseq, type, JsonDocument.Parse(payload).RootElement);

    [Fact]
    public void Submit_AssignsMonotonicSeq_AndApplies()
    {
        var room = new Room("doc");
        var r1 = room.Submit(Submit("A", 1, OpType.Create,
            """{"id":"o1","kind":"rect","z":"a0","props":{"x":10}}"""));
        var r2 = room.Submit(Submit("B", 1, OpType.Patch,
            """{"id":"o1","props":{"x":99}}"""));

        Assert.Equal(1, r1.Broadcast.Seq);
        Assert.Equal(2, r2.Broadcast.Seq);
        Assert.True(r1.IsNew && r2.IsNew);
        Assert.Equal(2, room.LastSeq);
    }

    [Fact]
    public void Submit_ClientRetry_ReturnsSameSeq_AppliesOnce()
    {
        var room = new Room("doc");
        var op = Submit("A", 7, OpType.Create,
            """{"id":"o1","kind":"rect","z":"a0","props":{"x":10}}""");
        var first = room.Submit(op);
        var retry = room.Submit(op); // WS flake → client resends pending

        Assert.False(retry.IsNew);
        Assert.Equal(first.Broadcast.Seq, retry.Broadcast.Seq);

        // Proof it applied once: a second create would still converge
        // (LWW), but journal length is the honest check — 1 entry.
        var join = room.Join("late", 0);
        Assert.Single(join.Ops);
    }

    [Fact]
    public void Join_ReturnsOpsSinceLastSeq()
    {
        var room = new Room("doc");
        room.Submit(Submit("A", 1, OpType.Create,
            """{"id":"o1","kind":"rect","z":"a0","props":{"x":10}}"""));
        room.Submit(Submit("A", 2, OpType.Patch,
            """{"id":"o1","props":{"x":20}}"""));
        room.Submit(Submit("B", 1, OpType.Patch,
            """{"id":"o1","props":{"x":30}}"""));

        var joined = room.Join("B", 1); // client saw seq 1, went dark
        Assert.Equal(2, joined.Ops.Count);
        Assert.Equal(2, joined.Ops[0].Seq);
        Assert.Equal(3, joined.Ops[1].Seq);
        Assert.Equal(3, joined.LastSeq);
    }

    [Fact]
    public void Rooms_AreIsolated_PerDocument()
    {
        var mgr = new RoomManager();
        var a = mgr.GetOrCreate("doc-a");
        var b = mgr.GetOrCreate("doc-b");

        a.Submit(Submit("X", 1, OpType.Create,
            """{"id":"o1","kind":"rect","z":"a0","props":{"x":1}}"""));

        Assert.Equal(1, a.LastSeq);
        Assert.Equal(0, b.LastSeq);
        Assert.Same(a, mgr.GetOrCreate("doc-a")); // get-or-add returns the live room
    }

    [Fact]
    public void Submit_ConcurrentClients_SeqTotalOrder()
    {
        // Ten clients × five ops racing — seq must be gapless
        // 1..50 and every op journaled exactly once.
        var room = new Room("doc");
        var results = new System.Collections.Concurrent.ConcurrentBag<long>();

        Parallel.For(0, 10, c =>
        {
            var client = $"c{c}";
            for (var i = 1; i <= 5; i++)
                results.Add(room.Submit(Submit(client, i, OpType.Create,
                    $$$"""{"id":"o{{{c}}}_{{{i}}}","kind":"rect","z":"a0","props":{"x":{{{i}}}}}"""))
                    .Broadcast.Seq);
        });

        Assert.Equal(50, results.Distinct().Count());
        Assert.Equal(50, room.LastSeq);
        Assert.Equal(Enumerable.Range(1, 50).Select(x => (long)x).OrderBy(x => x),
            results.OrderBy(x => x));
    }
}
