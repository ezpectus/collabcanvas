namespace CollabCanvas.Core.Room;

/// <summary>
/// Per-key token bucket (T-13): the hub rate-limits SubmitOp per
/// connection — presence already rate-limits fanout, but journal
/// writes had no cap at all, so one scripted client could mint ops
/// (and Redis stream entries) at network speed.
///
/// Generous default: 120 ops/s sustained, burst 240 — a human drag
/// peaks ~12 ops/s; a bot gets throttled, a user never notices.
/// Clock comes from outside (testable).
/// </summary>
public sealed class OpRateLimiter(double perSecond = 120, double burst = 240)
{
    private readonly Dictionary<string, (double Tokens, DateTimeOffset At)> _buckets = new();
    private readonly object _gate = new();

    /// <summary>Take a token. False = over the limit, caller drops.</summary>
    public bool Allow(string key, DateTimeOffset now)
    {
        lock (_gate)
        {
            var had = _buckets.TryGetValue(key, out var b);
            var tokens = had
                ? Math.Min(burst, b.Tokens + (now - b.At).TotalSeconds * perSecond)
                : burst;
            if (tokens < 1)
            {
                _buckets[key] = (tokens, now);
                return false;
            }
            _buckets[key] = (tokens - 1, now);
            return true;
        }
    }

    /// <summary>Connection-scoped buckets die with the connection —
    /// call on disconnect, else the dictionary leaks one row per
    /// socket ever opened.</summary>
    public void Drop(string key)
    {
        lock (_gate) _buckets.Remove(key);
    }
}
