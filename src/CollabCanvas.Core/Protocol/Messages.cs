using System.Text.Json;

namespace CollabCanvas.Core.Protocol;

/// <summary>
/// Wire contract between client and room (T-1 §4/§5). These are
/// transport shapes only — apply-semantics live in T-3, durability in
/// T-5, presence fanout in T-7.
/// </summary>
public enum OpType { Create, Patch, Delete, Reorder }

/// <summary>client → server: enter a document. lastSeq = what the
/// client already applied (0 = fresh join).</summary>
public sealed record JoinDocumentRequest(string DocId, string ClientId,
    long LastSeq,
    /// T-26 stage 3: share-link bearer grant (viewer|editor). Checked
    /// like membership — per join AND per op (revocation works on live
    /// sockets, not just new joins).
    string? Grant = null);

/// <summary>server → client: join answer. snapshotSeq+snapshot replace
/// state when present; ops = journal tail the client must replay.</summary>
public sealed record JoinResult(
    string DocId,
    long LastSeq,
    JsonElement? Snapshot,
    long SnapshotSeq,
    /// Server-resolved role for this connection (T-26): the client
    /// uses it to grey out tools it can't use — never to grant.
    IReadOnlyList<OpBroadcast> Ops,
    /// Server-resolved role for this connection (T-26): the client
    /// uses it to grey out tools it can't use — never to grant.
    string? Role = null);

/// <summary>client → server: one operation. clientId+clientSeq is the
/// idempotency key for client retries (T-1 §5).</summary>
public sealed record OpSubmit(
    string DocId,
    string ClientId,
    long ClientSeq,
    OpType Type,
    JsonElement Payload);

/// <summary>server → author: the op landed (or why not).</summary>
public sealed record OpAck(long ClientSeq, long Seq, bool Accepted, string? Reason);

/// <summary>server → everyone in the room: the applied op with its
/// server seq. Clients ignore seq <= their lastSeq.</summary>
public sealed record OpBroadcast(
    string DocId,
    long Seq,
    string ClientId,
    long ClientSeq,
    OpType Type,
    JsonElement Payload);

/// <summary>Ephemeral channel — NOT journaled, no seq (T-1 §8).</summary>
public sealed record PresenceUpdate(
    string DocId,
    string ClientId,
    JsonElement Cursor,
    string[] Selection,
    string Color,
    // Server-owned: the hub overwrites this with the resolved login —
    // a self-claimed name would be trivially spoofable.
    string? Name = null);

/// <summary>server → room: someone's presence changed.</summary>
public sealed record PresenceBroadcast(string ClientId, PresenceUpdate Update);

/// <summary>server → room: a cursor is gone (disconnect or TTL).</summary>
public sealed record PresenceLeft(string DocId, string ClientId);
