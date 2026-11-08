namespace CollabCanvas.Core.Model;

/// <summary>
/// Fractional indexing for z-order (T-6): a key BETWEEN two neighbors,
/// arbitrary precision, ordinal string order == position order.
/// Base-62 alphabet; keys NEVER end in the zero digit — that's the
/// invariant that makes "missing digit = 0" comparisons unambiguous
/// (between "a" and "a0" there is provably no valid key, so "a0" as
/// input is rejected rather than silently mishandled).
/// This is the same class of algorithm Figma/jitter use — a string of
/// fraction digits, no float64, so precision never exhausts; keys just
/// grow one digit per halving step.
/// </summary>
public static class FractionalIndex
{
    public const string Digits =
        "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

    /// <summary>Key k with a &lt; k &lt; b (null = -inf / +inf).
    /// Deterministic: same (a,b) → same k on every replica.</summary>
    public static string Between(string? a, string? b)
    {
        if (a is not null && b is not null && string.CompareOrdinal(a, b) >= 0)
            throw new ArgumentException($"Between: {a} >= {b}");
        if (EndsInZero(a) || EndsInZero(b))
            throw new ArgumentException("Between: key ends in zero digit");

        if (b is not null)
        {
            var n = 0; // longest common prefix (missing char reads as '0')
            while (CharAt(a, n) == CharAt(b, n)) n++;
            if (n > 0)
                return string.Concat(b.AsSpan(0, n),
                    Between(Tail(a, n), Tail(b, n)));
        }

        var da = a is { Length: > 0 } ? Digits.IndexOf(a[0]) : 0;
        var db = b is { Length: > 0 } ? Digits.IndexOf(b[0]) : Digits.Length;

        return db - da > 1
            ? Digits[(da + db) / 2].ToString()
            : Digits[da] + Between(Tail(a, 1), null);
    }

    /// <summary>First key for an empty list.</summary>
    public static string First() => Between(null, null);

    /// <summary>Key after <paramref name="last"/> (append / push to top).</summary>
    public static string After(string last) => Between(last, null);

    /// <summary>Key before <paramref name="first"/> (push to bottom).</summary>
    public static string Before(string first) => Between(null, first);

    // Missing chars read as '0', so the shared prefix can outlive the
    // string itself — a suffix beyond its length is just "".
    private static string Tail(string? s, int n) =>
        s is null || n >= s.Length ? "" : s[n..];

    private static char CharAt(string? s, int i) =>
        s is not null && i < s.Length ? s[i] : Digits[0];

    private static bool EndsInZero(string? s) =>
        s is { Length: > 0 } && s[^1] == Digits[0];
}
