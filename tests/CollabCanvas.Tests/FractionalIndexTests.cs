using CollabCanvas.Core.Model;

namespace CollabCanvas.Tests;

// T-6 gate: arbitrary-precision ordering keys. The invariants a
// replica needs: deterministic Between(a,b), strict a<k<b, and
// precision that never exhausts (keys grow, never fail).
public class FractionalIndexTests
{
    [Fact]
    public void Between_ProducesStrictlyOrderedKey()
    {
        var k = FractionalIndex.Between("a", "b");
        Assert.True(string.CompareOrdinal("a", k) < 0);
        Assert.True(string.CompareOrdinal(k, "b") < 0);
    }

    [Fact]
    public void Between_NullBounds_GivesFirstAndExtremes()
    {
        var first = FractionalIndex.First();
        var after = FractionalIndex.After(first);
        var before = FractionalIndex.Before(first);

        Assert.True(string.CompareOrdinal(first, after) < 0);
        Assert.True(string.CompareOrdinal(before, first) < 0);
    }

    [Fact]
    public void Between_SameNeighbors_Deterministic()
    {
        // Two replicas computing mid(a,b) must agree — no randomness,
        // no timestamp: the key IS the merge outcome.
        Assert.Equal(FractionalIndex.Between("a1", "a2"),
            FractionalIndex.Between("a1", "a2"));
    }

    [Fact]
    public void Between_RepeatedHalving_NeverExhausts()
    {
        // The float64 killer: 500 inserts between the same two keys.
        // Strings grow ~1 char per halving — bounded, never fails.
        var lo = "a"; var hi = "b";
        var keys = new List<string>();
        for (var i = 0; i < 500; i++)
        {
            var k = FractionalIndex.Between(lo, hi);
            Assert.True(string.CompareOrdinal(lo, k) < 0);
            Assert.True(string.CompareOrdinal(k, hi) < 0);
            keys.Add(k);
            hi = k; // squeeze into the shrinking gap
        }
        Assert.All(keys, k => Assert.False(k.EndsWith('0')));
        Assert.True(keys[^1].Length < 600); // sanity: linear-ish growth
    }

    [Fact]
    public void Between_RandomInsertOrder_FinalOrderConsistent()
    {
        // Simulate two clients inserting at different positions: keys
        // must order exactly as the logical list, whatever the path.
        var rng = new Random(42);
        var positions = new List<string> { FractionalIndex.First() };

        for (var i = 0; i < 200; i++)
        {
            var idx = rng.Next(positions.Count + 1); // logical insert index
            var lo = idx > 0 ? positions[idx - 1] : null;
            var hi = idx < positions.Count ? positions[idx] : null;
            positions.Insert(idx, FractionalIndex.Between(lo, hi));
        }

        var sorted = positions.OrderBy(p => p, StringComparer.Ordinal).ToList();
        Assert.Equal(positions, sorted); // string order == insert order
    }

    [Fact]
    public void Between_InvalidInputs_Throw()
    {
        Assert.Throws<ArgumentException>(() => FractionalIndex.Between("b", "a")); // a>=b
        Assert.Throws<ArgumentException>(() => FractionalIndex.Between("x", "x"));
        Assert.Throws<ArgumentException>(() => FractionalIndex.Between("a", "a0")); // trailing zero — no key exists
        Assert.Throws<ArgumentException>(() => FractionalIndex.Between("a0", "b"));
    }
}
