using System.Text.Json;
using CollabCanvas.Core.Protocol;
using CollabCanvas.Core.Room;
using StackExchange.Redis;

namespace CollabCanvas.Api.Journal;

/// <summary>
/// Redis pub/sub transport (T-10): channels doc:{id}:in (submits →
/// owner) and doc:{id}:out (sequenced ops → everyone). Ownership is
/// an expiring claim `doc:{id}:owner` via SET NX, renewed by a timer.
///
/// HONEST EDGES:
/// 1. The claim is advisory — no fencing token. If the owner stalls
/// past TTL and another instance claims, a split-brain window opens
/// where BOTH think they own the seq (divergent seq for the same
/// doc; journal becomes the merge witness). Real fix = sticky
/// routing or fencing — documented, accepted for MVP.
/// 2. Fail-open: any Redis error in <see cref="Owns"/> → local
/// ownership. Two instances in this state are a silent split-brain —
/// /health "degraded" is the only signal.
/// 3. pub/sub is at-most-once: an op published while a peer is
/// down is gone; late joiners re-sync via journal (T-5), live
/// clients see a gap only if they miss :out AND their seq window —
/// they'd catch it as a stale join on reconnect.
/// </summary>
public sealed class RedisRoomTransport : IRoomTransport, IDisposable
{
    private const int OwnerTtlSec = 15;

    private readonly IConnectionMultiplexer _mux;
    private readonly string _instance = Guid.NewGuid().ToString("N")[..8];
    private readonly HashSet<string> _owned = new();
    private readonly HashSet<string> _subscribed = new();
    private readonly object _gate = new();
    private readonly Timer _renew;

    public RedisRoomTransport(IConnectionMultiplexer mux)
    {
        _mux = mux;
        _renew = new Timer(RenewClaims, null,
            TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(5));
    }

    public event Action<OpSubmit>? OnSubmit;
    public event Action<OpBroadcast>? OnBroadcast;

    private static string InKey(string docId) => $"doc:{docId}:in";
    private static string OutKey(string docId) => $"doc:{docId}:out";
    private static string OwnerKey(string docId) => $"doc:{docId}:owner";

    private ISubscriber Sub => _mux.GetSubscriber();

    public bool Owns(string docId)
    {
        EnsureSubscribed(docId);
        lock (_gate)
        {
            if (_owned.Contains(docId)) return true;
            try
            {
                var claimed = _mux.GetDatabase().StringSet(
                    OwnerKey(docId), _instance,
                    TimeSpan.FromSeconds(OwnerTtlSec), When.NotExists);
                if (!claimed) return false;
                _owned.Add(docId);
                Sub.Subscribe(RedisChannel.Literal(InKey(docId)), (_, v) =>
                {
                    var op = JsonSerializer.Deserialize<OpSubmit>(v.ToString());
                    if (op is not null) OnSubmit?.Invoke(op);
                });
                return true;
            }
            catch (Exception e) when (e is RedisException
                or RedisTimeoutException or RedisConnectionException)
            {
                // Fail-open: degraded mode = local ownership (see doc).
                _owned.Add(docId);
                return true;
            }
        }
    }

    public async Task SubmitRemoteAsync(OpSubmit op)
    {
        try { await Sub.PublishAsync(RedisChannel.Literal(InKey(op.DocId)),
            JsonSerializer.Serialize(op)); }
        catch (Exception e) when (e is RedisException
            or RedisTimeoutException or RedisConnectionException) { }
    }

    public async Task BroadcastAsync(OpBroadcast op)
    {
        try { await Sub.PublishAsync(RedisChannel.Literal(OutKey(op.DocId)),
            JsonSerializer.Serialize(op)); }
        catch (Exception e) when (e is RedisException
            or RedisTimeoutException or RedisConnectionException) { }
    }

    private void EnsureSubscribed(string docId)
    {
        lock (_gate)
        {
            if (!_subscribed.Add(docId)) return;
            try
            {
                Sub.Subscribe(RedisChannel.Literal(OutKey(docId)), (_, v) =>
                {
                    var op = JsonSerializer.Deserialize<OpBroadcast>(v.ToString());
                    if (op is not null) OnBroadcast?.Invoke(op);
                });
            }
            catch (Exception e) when (e is RedisException
                or RedisTimeoutException or RedisConnectionException)
            {
                _subscribed.Remove(docId); // retry on next contact
            }
        }
    }

    /// <summary>Renew claims before TTL; if the key now names another
    /// owner (expired + reclaimed, or lost SET NX race) we concede —
    /// the inbox subscription stays but submits stop routing here
    /// because Owns() rechecks on every op.</summary>
    private void RenewClaims(object? _)
    {
        string[] owned;
        lock (_gate) owned = [.. _owned];
        var db = _mux.GetDatabase();
        foreach (var docId in owned)
        {
            try
            {
                var v = db.StringGet(OwnerKey(docId));
                if (v != _instance)
                {
                    lock (_gate) _owned.Remove(docId); // concede
                    continue;
                }
                db.KeyExpire(OwnerKey(docId), TimeSpan.FromSeconds(OwnerTtlSec));
            }
            catch (Exception e) when (e is RedisException
                or RedisTimeoutException or RedisConnectionException) { }
        }
    }

    public void Dispose() => _renew.Dispose();
}
