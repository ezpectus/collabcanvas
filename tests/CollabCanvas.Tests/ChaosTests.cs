using System.Text.Json;
using CollabCanvas.Core.Journal;
using CollabCanvas.Core.Model;
using CollabCanvas.Core.Protocol;
using CollabCanvas.Core.Room;

namespace CollabCanvas.Tests;

// T-10 gate: the delivery guarantees, broken on purpose. Each test
// names the failure it simulates — the point is proving the DESIGN
// absorbs it, not that failures don't happen.
public class ChaosTests
{
    private static OpSubmit Submit(string client, long cseq, OpType type, string payload) =>
        new("doc", client, cseq, type, JsonDocument.Parse(payload).RootElement);

    private static OpSubmit Create(string client, long cseq, string id, int x) =>
        Submit(client, cseq, OpType.Create,
            $$$"""{"id":"{{{id}}}","kind":"rect","z":"a0","props":{"x":{{{x}}}}}""");

    /// <summary>Journal that "loses power" after N appends — the tail
    /// beyond the limit never existed. Kill-mid-stream, honest.</summary>
    private sealed class CrashAfterJournal(int survives) : IOpJournal
    {
        private readonly InMemoryOpJournal _inner = new();
        private int _appended;

        public long FirstSeq => _inner.FirstSeq;
        public void Append(OpBroadcast op)
        {
            if (_appended++ < survives) _inner.Append(op); // else: lost to the crash
        }
        public IReadOnlyList<OpBroadcast> ReadSince(long seq) => _inner.ReadSince(seq);
        public RoomSnapshot? LoadSnapshot() => _inner.LoadSnapshot();
        public void WriteSnapshot(long seq, string json) => _inner.WriteSnapshot(seq, json);
    }

    [Fact]
    public void ShuffledAndDuplicatedDelivery_Converges()
    {
        // pub/sub re-delivery + reordering (T-10 reality): apply the
        // same ops shuffled WITH duplicates — state must be identical
        // to in-order application. LWW registers are the absorber.
        var room = new Room("doc");
        var ops = new List<OpBroadcast>();
        for (var i = 1; i <= 60; i++)
        {
            var op = i % 3 == 0
                ? Submit("B", i / 3, OpType.Patch,
                    $$$"""{"id":"o{{{i % 10}}}","props":{"x":{{{i}}}}}""")
                : Create("A", i, $"o{i % 10}", i);
            ops.Add(room.Submit(op).Broadcast);
        }
        var expected = room.Snapshot();

        var rng = new Random(7);
        var shuffled = ops.OrderBy(_ => rng.Next())
            .Concat(ops.Where((_, i) => i % 4 == 0)) // inject re-deliveries
            .OrderBy(_ => rng.Next())
            .ToList();

        var replica = new Document();
        foreach (var op in shuffled) replica.Apply(op);

        Assert.Equal(expected, replica.Snapshot());
    }

    [Fact]
    public void KillMidStream_RestartLosesTail_Honestly()
    {
        // Server dies after append #5: ops 6..10 were applied+broadcast
        // but never journaled. Recovery must show EXACTLY the durable
        // prefix — the clients saw ops the room forgot; rejoin heals.
        var store = new CrashAfterJournal(survives: 5);
        var r1 = new Room("doc", store);
        for (var i = 1; i <= 10; i++)
            r1.Submit(Create("A", i, $"o{i}", i));

        var r2 = new Room("doc", store);
        Assert.Equal(5, r2.LastSeq); // honest loss, not hidden
        // And new writes continue from the recovered seq — a client
        // retrying op 6 gets a FRESH seq 6, not a phantom conflict.
        var retry = r2.Submit(Create("A", 6, "o6", 6));
        Assert.True(retry.IsNew);
        Assert.Equal(6, retry.Broadcast.Seq);
    }

    [Fact]
    public void ReconnectStorm_JoinsGetConsistentTails()
    {
        // 20 clients reconnecting simultaneously after a server
        // restart — every one gets a gapless, identical tail.
        var store = new InMemoryOpJournal();
        var room = new Room("doc", store);
        for (var i = 1; i <= 50; i++)
            room.Submit(Create("A", i, $"o{i}", i));

        var results = Enumerable.Range(0, 20).AsParallel()
            .Select(c => room.Join($"c{c}", 40).Ops.Select(o => o.Seq).ToArray())
            .ToList();

        foreach (var tail in results)
            Assert.Equal(Enumerable.Range(41, 10).Select(i => (long)i), tail);
    }
}
