using CollabCanvas.Core.Protocol;

namespace CollabCanvas.Core.Room;

/// <summary>
/// Cross-instance op transport (T-10): makes "one room per doc"
/// work when clients land on different API instances.
///
/// Ownership: exactly one instance OWNS a doc's ordering point —
/// its Room assigns seq. Non-owners relay submits through the
/// owner's inbox and serve joins from the journal directly.
///
/// Events:
/// - <see cref="OnSubmit"/>: fires on the OWNER for ops published
///   by non-owners (the router applies + broadcasts them).
/// - <see cref="OnBroadcast"/>: fires on EVERY instance for each
///   sequenced op — including the owner's own (uniform fanout).
///
/// Implementations: RedisRoomTransport (pub/sub + SET NX ownership),
/// LocalRoomTransport (single instance / Redis-down degraded mode).
/// </summary>
public interface IRoomTransport
{
    /// <summary>Claim/report ownership of this doc's ordering point.
    /// Side effect: ensures this instance is subscribed to the doc's
    /// channels (called on first contact with the doc).</summary>
    bool Owns(string docId);

    /// <summary>Non-owner → owner inbox: an unsequenced client op.</summary>
    Task SubmitRemoteAsync(OpSubmit op);

    /// <summary>Owner → everyone: a sequenced op for fanout.</summary>
    Task BroadcastAsync(OpBroadcast op);

    event Action<OpSubmit>? OnSubmit;
    event Action<OpBroadcast>? OnBroadcast;
}

/// <summary>Single-process transport: owns everything, events fire
/// synchronously. Used in tests and as the degraded shape when the
/// bus is unreachable (Redis transport itself fails open to local
/// ownership — see RedisRoomTransport).</summary>
public sealed class LocalRoomTransport : IRoomTransport
{
    public bool Owns(string docId) => true;

    public Task SubmitRemoteAsync(OpSubmit op)
    {
        OnSubmit?.Invoke(op);
        return Task.CompletedTask;
    }

    public Task BroadcastAsync(OpBroadcast op)
    {
        OnBroadcast?.Invoke(op);
        return Task.CompletedTask;
    }

    public event Action<OpSubmit>? OnSubmit;
    public event Action<OpBroadcast>? OnBroadcast;
}
