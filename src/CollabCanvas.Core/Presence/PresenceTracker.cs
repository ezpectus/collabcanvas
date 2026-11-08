using CollabCanvas.Core.Protocol;

namespace CollabCanvas.Core.Presence;

/// <summary>
/// Ephemeral presence per room (T-7): latest cursor/selection per
/// client. NOT journaled, no seq — a cursor lives seconds; replaying
/// it on restart would be garbage.
///
/// Two lifetimes managed here:
/// - Liveness: every Update refreshes lastSeen; entries idle longer
///   than <see cref="Ttl"/> are returned by <see cref="Expire"/> for
///   the sweeper to broadcast "presence-left". A heartbeat is just an
///   Update with the same payload — no separate message type needed.
/// - Rate: <see cref="Update"/> returns false while a client spams
///   faster than <see cref="MinInterval"/> — the latest value is still
///   stored (join snapshot stays fresh), only the fanout is dropped.
///
/// All methods take `now` — no clock inside, fully testable.
/// </summary>
public sealed class PresenceTracker
{
    public static readonly TimeSpan Ttl = TimeSpan.FromSeconds(10);
    public static readonly TimeSpan MinInterval = TimeSpan.FromMilliseconds(100);

    private readonly object _gate = new(); // hub calls are concurrent
    private readonly Dictionary<string, (PresenceUpdate Update,
        DateTimeOffset LastSeen, DateTimeOffset LastBroadcast)> _byClient = new();

    /// <summary>Store + heartbeat. Returns true if this update should
    /// be fanned out now (rate-limit drop keeps the stored value).</summary>
    public bool Update(string clientId, PresenceUpdate update, DateTimeOffset now)
    {
        lock (_gate)
        {
            var had = _byClient.TryGetValue(clientId, out var prev);
            var forward = !had || now - prev.LastBroadcast >= MinInterval;
            _byClient[clientId] = (update, now, forward ? now : prev.LastBroadcast);
            return forward;
        }
    }

    public void Remove(string clientId)
    {
        lock (_gate) _byClient.Remove(clientId);
    }

    /// <summary>Clients idle past TTL — the sweeper tells the room
    /// their cursors are gone. Sweep period matters less than TTL:
    /// worst-case ghost lifetime = TTL + sweep interval.</summary>
    public string[] Expire(DateTimeOffset now)
    {
        lock (_gate)
        {
            var dead = _byClient.Where(kv => now - kv.Value.LastSeen > Ttl)
                .Select(kv => kv.Key).ToArray();
            foreach (var id in dead) _byClient.Remove(id);
            return dead;
        }
    }

    /// <summary>Current live entries — snapshot for a fresh joiner.</summary>
    public IReadOnlyDictionary<string, PresenceUpdate> Current()
    {
        lock (_gate)
            return _byClient.ToDictionary(kv => kv.Key, kv => kv.Value.Update);
    }
}
