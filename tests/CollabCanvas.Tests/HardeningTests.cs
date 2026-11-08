using System.Text.Json;
using CollabCanvas.Core.Protocol;
using CollabCanvas.Core.Room;

namespace CollabCanvas.Tests;

// T-13 gate: garbage stays out of the journal and bots stay out of
// the op budget. Validator runs BEFORE Room.Submit on the wire path.
public class HardeningTests
{
    private static OpSubmit Op(string payload, OpType type = OpType.Create,
        string docId = "doc", string clientId = "A") =>
        new(docId, clientId, 1, type, JsonDocument.Parse(payload).RootElement);

    [Theory]
    [InlineData("""{"id":"o1","kind":"rect","z":"a0","props":{"x":1}}""", OpType.Create)]  // z ends '0' — un-orderable
    [InlineData("""{"id":"o1","kind":"blob","z":"a1","props":{}}""", OpType.Create)]       // unknown kind
    [InlineData("""{"id":"o1","kind":"rect","z":"a!","props":{}}""", OpType.Create)]       // z off-alphabet
    [InlineData("""{"kind":"rect","props":{}}""", OpType.Create)]                          // no id
    [InlineData("""{"id":123,"kind":"rect","props":{}}""", OpType.Create)]                 // id not string — would THROW in Apply
    [InlineData("""{"id":"o1"}""", OpType.Patch)]                                          // patch without props
    [InlineData("""{"id":"o1","z":"a0"}""", OpType.Reorder)]                               // reorder to un-orderable z
    public void Validate_RejectsGarbage(string payload, OpType type)
    {
        Assert.NotNull(OpValidator.Validate(Op(payload, type)));
    }

    [Fact]
    public void Validate_AcceptsRealOps()
    {
        Assert.Null(OpValidator.Validate(Op(
            """{"id":"o1","kind":"rect","z":"aV","props":{"x":1,"fill":"#fff"}}""")));
        Assert.Null(OpValidator.Validate(Op(
            """{"id":"o1","props":{"x":9}}""", OpType.Patch)));
        Assert.Null(OpValidator.Validate(Op("""{"id":"o1"}""", OpType.Delete)));
        Assert.Null(OpValidator.Validate(Op("""{"id":"o1","z":"aV"}""", OpType.Reorder)));
    }

    [Fact]
    public void Validate_RejectsOversized()
    {
        var huge = "{\"id\":\"o1\",\"kind\":\"rect\",\"props\":{\"t\":\""
            + new string('x', OpValidator.MaxPayloadBytes) + "\"}}";
        Assert.Equal("payload too large", OpValidator.Validate(Op(huge)));

        var props = string.Join(',', Enumerable.Range(0, OpValidator.MaxProps + 1)
            .Select(i => $"\"p{i}\":1"));
        Assert.Equal("too many props",
            OpValidator.Validate(Op("{\"id\":\"o1\",\"kind\":\"rect\",\"props\":{" + props + "}}")));
    }

    [Fact]
    public void Validate_RejectsBadIds()
    {
        var bad = Op("""{"id":"o1"}""", OpType.Delete, docId: "doc:evil");
        Assert.Equal("bad docId", OpValidator.Validate(bad)); // ':' would fork the Redis key namespace
    }

    [Fact]
    public void RateLimiter_BurstThenThrottle()
    {
        var lim = new OpRateLimiter(perSecond: 10, burst: 5);
        var t0 = new DateTimeOffset(2026, 11, 8, 0, 0, 0, TimeSpan.Zero);

        for (var i = 0; i < 5; i++) Assert.True(lim.Allow("c1", t0));
        Assert.False(lim.Allow("c1", t0));                    // burst spent
        Assert.True(lim.Allow("c2", t0));                     // other connection unaffected
        Assert.True(lim.Allow("c1", t0.AddMilliseconds(150))); // +1.5 tokens
    }

    [Fact]
    public void RateLimiter_Drop_ReleasesBucket()
    {
        var lim = new OpRateLimiter(perSecond: 10, burst: 1);
        var t0 = DateTimeOffset.UtcNow;
        Assert.True(lim.Allow("c1", t0));
        Assert.False(lim.Allow("c1", t0));
        lim.Drop("c1");                                       // disconnect → fresh bucket
        Assert.True(lim.Allow("c1", t0));
    }
}
