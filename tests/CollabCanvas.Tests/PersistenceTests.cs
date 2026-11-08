using System.Text.Json;
using CollabCanvas.Core.Journal;
using CollabCanvas.Core.Protocol;
using CollabCanvas.Core.Room;

namespace CollabCanvas.Tests;

// T-5 gate: journal + snapshot + recovery. Hermetic — InMemoryOpJournal
// stands in for Redis (the contract is identical; Redis impl is verified
// by smoke, not unit tests). A "restart" = new Room over the same store.
public class PersistenceTests
{
    private static OpSubmit Submit(string client, long cseq, OpType type, string payload) =>
        new("doc", client, cseq, type, JsonDocument.Parse(payload).RootElement);

    private static OpSubmit Create(string client, long cseq, string id, int x) =>
        Submit(client, cseq, OpType.Create,
            $$$"""{"id":"{{{id}}}","kind":"rect","z":"a0","props":{"x":{{{x}}}}}""");

    [Fact]
    public void Restart_ReplaysJournal_StateSurvives()
    {
        var store = new InMemoryOpJournal();
        var r1 = new Room("doc", store);
        r1.Submit(Create("A", 1, "o1", 10));
        r1.Submit(Submit("A", 2, OpType.Patch, """{"id":"o1","props":{"x":99}}"""));

        var r2 = new Room("doc", store); // "server restart"
        Assert.Equal(2, r2.LastSeq);
        Assert.Equal(r1.Snapshot(), r2.Snapshot());
    }

    [Fact]
    public void Restart_SnapshotPlusTail_Converges()
    {
        var store = new InMemoryOpJournal();
        var r1 = new Room("doc", store);
        for (var i = 1; i <= Room.SnapshotEveryOps; i++)
            r1.Submit(Create("A", i, $"o{i}", i)); // triggers snapshot at seq 100
        Assert.Equal(Room.SnapshotEveryOps, store.LoadSnapshot()!.Seq);

        r1.Submit(Create("A", 101, "o101", 7)); // tail after snapshot
        var r2 = new Room("doc", store);
        Assert.Equal(r1.Snapshot(), r2.Snapshot());
        Assert.Equal(101, r2.LastSeq);
    }

    [Fact]
    public void Restart_ClientRetry_StillDeduped()
    {
        // The journaled op carries clientId+clientSeq — recovery rebuilds
        // the dedup index, so a retry after RESTART gets its original seq.
        var store = new InMemoryOpJournal();
        var r1 = new Room("doc", store);
        var first = r1.Submit(Create("A", 5, "o1", 1));

        var r2 = new Room("doc", store);
        var retry = r2.Submit(Create("A", 5, "o1", 1));
        Assert.False(retry.IsNew);
        Assert.Equal(first.Broadcast.Seq, retry.Broadcast.Seq);
        Assert.Equal(1, r2.LastSeq); // not re-applied
    }

    [Fact]
    public void Join_BelowJournalBase_GetsSnapshot()
    {
        // Journal truncated below the snapshot: client lastSeq=5 can no
        // longer be served ops — it must take snapshot+tail instead.
        var store = new InMemoryOpJournal(maxLen: 10);
        var room = new Room("doc", store);
        for (var i = 1; i <= Room.SnapshotEveryOps; i++)
            room.Submit(Create("A", i, $"o{i}", i));
        for (var i = 101; i <= 115; i++)
            room.Submit(Create("A", i, $"o{i}", i)); // journal now holds ~106..115

        var join = room.Join("late", 5);
        Assert.NotNull(join.Snapshot);
        Assert.Equal(Room.SnapshotEveryOps, join.SnapshotSeq);
        Assert.All(join.Ops, o => Assert.True(o.Seq > join.SnapshotSeq));

        // A client inside the journal window still gets a plain tail.
        var join2 = room.Join("fresh", 110);
        Assert.Null(join2.Snapshot);
        Assert.Equal(5, join2.Ops.Count);
    }

    [Fact]
    public void Join_FutureLastSeq_GetsSnapshot()
    {
        // Client claims seq beyond ours — server lost data (or client is
        // confused). Snapshot+tail is the only honest answer.
        var store = new InMemoryOpJournal();
        var room = new Room("doc", store);
        room.Submit(Create("A", 1, "o1", 1));

        var join = room.Join("B", 999);
        Assert.NotNull(join.Snapshot);
        Assert.Equal(1, join.LastSeq);
    }

    [Fact]
    public void Restart_TruncatedJournal_SnapshotCoversGap()
    {
        // Kill the room, truncate the journal below snapSeq, restart —
        // the snapshot alone must reproduce state (tail replays on top).
        var store = new InMemoryOpJournal(maxLen: 5);
        var r1 = new Room("doc", store);
        for (var i = 1; i <= Room.SnapshotEveryOps; i++)
            r1.Submit(Create("A", i, $"o{i}", i)); // journal keeps only ~96..100

        var r2 = new Room("doc", store);
        Assert.Equal(r1.Snapshot(), r2.Snapshot()); // snapshot rebuilds all 100
    }
}
