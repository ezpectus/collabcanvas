using System.Text.Json;
using CollabCanvas.Core.Model;
using CollabCanvas.Core.Protocol;

namespace CollabCanvas.Tests;

// T-3 gate: the apply semantics. Convergence (any op order → same
// state), idempotency (op twice = no-op), delete-vs-patch (no
// resurrection without create), and LWW conflict resolution.
public class DocumentApplyTests
{
    private static OpBroadcast Op(long seq, OpType type, string payload) =>
        new("doc", seq, "client", seq, type, JsonDocument.Parse(payload).RootElement);

    private static OpBroadcast CreateRect(long seq, string id, double x) =>
        Op(seq, OpType.Create, $$$"""{"id":"{{{id}}}","kind":"rect","z":"a0","props":{"x":{{{x}}},"y":0,"w":10,"h":10}}""");

    [Fact]
    public void Apply_CreatePatch_UpdatesProperty()
    {
        var doc = new Document();
        doc.Apply(CreateRect(1, "o1", 10));
        doc.Apply(Op(2, OpType.Patch, """{"id":"o1","props":{"x":120}}"""));

        var obj = Assert.Single(doc.Objects());
        Assert.Equal(120, obj.Props["x"].GetDouble());
        Assert.Equal(2, doc.LastSeq);
    }

    [Fact]
    public void Apply_IsIdempotent_OpTwiceNoChange()
    {
        var doc = new Document();
        var create = CreateRect(1, "o1", 10);
        var patch = Op(2, OpType.Patch, """{"id":"o1","props":{"x":120}}""");
        doc.Apply(create); doc.Apply(patch);
        var once = doc.Snapshot();
        doc.Apply(create); doc.Apply(patch);
        Assert.Equal(once, doc.Snapshot());
    }

    [Fact]
    public void Apply_SamePropConflict_HighestSeqWins()
    {
        // Two clients move the same rect — last server seq wins on
        // every replica, regardless of arrival order.
        var forward = new Document();
        forward.Apply(CreateRect(1, "o1", 0));
        forward.Apply(Op(5, OpType.Patch, """{"id":"o1","props":{"x":100}}""")); // client A
        forward.Apply(Op(9, OpType.Patch, """{"id":"o1","props":{"x":200}}""")); // client B

        var reversed = new Document();
        reversed.Apply(CreateRect(1, "o1", 0));
        reversed.Apply(Op(9, OpType.Patch, """{"id":"o1","props":{"x":200}}"""));
        reversed.Apply(Op(5, OpType.Patch, """{"id":"o1","props":{"x":100}}"""));

        Assert.Equal(forward.Snapshot(), reversed.Snapshot());
        Assert.Equal(200, forward.Objects().Single().Props["x"].GetDouble());
    }

    [Fact]
    public void Apply_ArbitraryOrder_Converges()
    {
        // Full shuffle incl. patch-before-create: the LWW registers
        // still converge — the seq IS the order.
        OpBroadcast[] ops =
        [
            CreateRect(1, "o1", 0),
            Op(2, OpType.Create, """{"id":"o2","kind":"ellipse","z":"a1","props":{"x":50,"y":50}}"""),
            Op(3, OpType.Patch, """{"id":"o1","props":{"x":30}}"""),
            Op(4, OpType.Reorder, """{"id":"o1","z":"a2"}"""),
            Op(5, OpType.Delete, """{"id":"o2"}"""),
            Op(6, OpType.Patch, """{"id":"o2","props":{"x":999}}"""), // patch after delete — must NOT resurrect
        ];

        var baseline = new Document();
        foreach (var op in ops) baseline.Apply(op);

        var rng = new Random(42);
        var shuffled = ops.OrderBy(_ => rng.Next()).ToArray();
        var shaken = new Document();
        foreach (var op in shuffled) shaken.Apply(op);

        Assert.Equal(baseline.Snapshot(), shaken.Snapshot());
        Assert.Single(baseline.Objects()); // o2 stays dead
        Assert.Equal("a2", baseline.Objects().Single().Z);
    }

    [Fact]
    public void Apply_RecreateWithHigherSeq_Resurrects()
    {
        var doc = new Document();
        doc.Apply(CreateRect(1, "o1", 10));
        doc.Apply(Op(5, OpType.Delete, """{"id":"o1"}"""));
        Assert.Empty(doc.Objects());

        doc.Apply(CreateRect(8, "o1", 77)); // create wins over older delete
        var obj = Assert.Single(doc.Objects());
        Assert.Equal(77, obj.Props["x"].GetDouble());
    }

    [Fact]
    public void Apply_OldCreateCannotResurrect()
    {
        var doc = new Document();
        doc.Apply(Op(5, OpType.Delete, """{"id":"o1"}""")); // delete lands first (replay edge)
        doc.Apply(CreateRect(1, "o1", 10));                 // older create loses
        Assert.Empty(doc.Objects());
    }
}
