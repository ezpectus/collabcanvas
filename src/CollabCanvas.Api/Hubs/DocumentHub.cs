using CollabCanvas.Core.Journal;
using CollabCanvas.Core.Protocol;
using CollabCanvas.Core.Room;
using Microsoft.AspNetCore.SignalR;

namespace CollabCanvas.Api.Hubs;

/// <summary>
/// Document room endpoint — thin SignalR adapter (T-10 wiring).
/// Ordering/dedup/apply live in the Room on the OWNING instance;
/// this hub only routes:
/// - submit: owner → Room.Submit → transport.Broadcast (OpRouter
///   fans it to all groups incl. this one); non-owner → publish to
///   the owner's inbox, ack "forwarded" (the echo carries real seq).
/// - join: owner → Room.Join; non-owner → built straight from the
///   journal — ops/snapshot are in Redis, no room needed locally.
/// </summary>
public sealed class DocumentHub(
    RoomManager rooms,
    IRoomTransport transport,
    IOpJournalFactory journals,
    OpRateLimiter opLimit,
    StackExchange.Redis.IConnectionMultiplexer redis,
    CollabCanvas.Api.Auth.UserStore users,
    CollabCanvas.Api.Auth.MembershipStore members) : Hub
{
    /// T-26: resolve the SignalR access_token once at connect; the
    /// login becomes the trusted presence name (Name in PresenceUpdate
    /// is server-owned — clients can't spoof it).
    public override async Task OnConnectedAsync()
    {
        // Browser SignalR can't set WS headers → access_token query;
        // the Node client CAN → Authorization header. Take either.
        var http = Context.GetHttpContext();
        var token = http?.Request.Query["access_token"].ToString();
        if (string.IsNullOrEmpty(token))
        {
            var h = http?.Request.Headers.Authorization.ToString();
            if (h?.StartsWith("Bearer ", StringComparison.Ordinal) == true)
                token = h["Bearer ".Length..];
        }
        if (await users.ResolveAsync(token) is { } who)
        {
            Context.Items["uid"] = who.id;
            Context.Items["login"] = who.login;
            Context.Items["token"] = token;
        }
        await base.OnConnectedAsync();
    }

    /// T-26 stage 2+3: the connection's role — member beats link
    /// beats legacy: membership, then bearer grant, then "legacy
    /// editor" when the doc is unowned. Guests on owned docs need a
    /// valid grant; owner/admin are never grantable by link.
    private async Task<CollabCanvas.Api.Auth.RoomRole?> EffectiveRole(
        string docId, string? grant)
    {
        // Re-resolve the bearer token per call — a logged-out or
        // expired session must not keep member rights on a live
        // socket (same no-cache policy as membership revocation;
        // one extra Redis read per op is the honest price).
        if (Context.Items["token"] is string tok &&
            await users.ResolveAsync(tok) is { } who &&
            await members.RoleOfAsync(docId, who.login) is { } m)
            return m;
        if (grant is not null &&
            await members.LinkRoleAsync(docId, grant) is { } l)
            return l;
        return await members.IsOwnedAsync(docId)
            ? null : CollabCanvas.Api.Auth.RoomRole.Editor; // legacy open
    }

    public async Task<JoinResult> JoinDocument(JoinDocumentRequest req)
    {
        // Owned doc, no membership/grant → denied. HubException
        // surfaces as an invoke rejection on the client.
        var role = await EffectiveRole(req.DocId, req.Grant);
        if (role is null)
            throw new HubException("forbidden: members only");
        // Keep the grant for per-op revalidation — a revoked link
        // stops this socket on the next SubmitOp, not just next join.
        if (req.Grant is not null) Context.Items["grant"] = req.Grant;

        var room = rooms.GetOrCreate(req.DocId);
        // T-19: index the doc for the /docs listing. Fire-and-forget —
        // a Redis outage degrades discovery, never the join itself.
        _ = redis.GetDatabase().SetAddAsync("docs", req.DocId);
        await Groups.AddToGroupAsync(Context.ConnectionId, req.DocId);
        rooms.TrackConnection(Context.ConnectionId, req.DocId, req.ClientId);

        if (transport.Owns(req.DocId))
        {
            var join = room.Join(req.ClientId, req.LastSeq);
            await Clients.Caller.SendAsync("presence-state", room.Presence.Current());
            return join with { Role = CollabCanvas.Api.Auth.MembershipStore.Name(role.Value) };
        }

        // Non-owner: answer from the durable journal directly.
        var store = journals.ForDoc(req.DocId);
        var snap = store.LoadSnapshot();
        if (req.LastSeq >= store.FirstSeq)
        {
            var tail = store.ReadSince(req.LastSeq);
            var lastSeq = Math.Max(snap?.Seq ?? 0,
                tail.Count > 0 ? tail[^1].Seq : 0);
            return new JoinResult(req.DocId, lastSeq, null, snap?.Seq ?? 0,
                tail, CollabCanvas.Api.Auth.MembershipStore.Name(role.Value));
        }
        var sinceSnap = store.ReadSince(snap?.Seq ?? 0);
        return new JoinResult(req.DocId,
            Math.Max(snap?.Seq ?? 0, sinceSnap.Count > 0 ? sinceSnap[^1].Seq : 0),
            snap is null ? null : System.Text.Json.JsonDocument.Parse(snap.Json).RootElement,
            snap?.Seq ?? 0, sinceSnap,
            CollabCanvas.Api.Auth.MembershipStore.Name(role.Value));
    }

    public async Task LeaveDocument(string docId) =>
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, docId);

    public async Task<OpAck> SubmitOp(OpSubmit op)
    {
        // T-13: validate + rate-limit BEFORE the room — a malformed op
        // must never reach the journal, and one scripted client must
        // never mint ops at network speed.
        if (!opLimit.Allow(Context.ConnectionId, DateTimeOffset.UtcNow))
            return new OpAck(op.ClientSeq, -1, Accepted: false, Reason: "rate-limited");
        // Per-op role check (T-26): covers revocation — a removed
        // member or dead link stops mutating on the very next op.
        if (await EffectiveRole(op.DocId,
                Context.Items["grant"] as string) is not { } r ||
            r < CollabCanvas.Api.Auth.RoomRole.Editor)
            return new OpAck(op.ClientSeq, -1, Accepted: false, Reason: "forbidden");
        if (OpValidator.Validate(op) is { } why)
            return new OpAck(op.ClientSeq, -1, Accepted: false, Reason: $"invalid: {why}");

        if (transport.Owns(op.DocId))
        {
            var room = rooms.GetOrCreate(op.DocId);
            var result = room.Submit(op);
            // Fanout goes through the transport (OpRouter → group) so
            // multi-instance behaves identically to single-instance.
            await transport.BroadcastAsync(result.Broadcast);
            return new OpAck(op.ClientSeq, result.Broadcast.Seq,
                Accepted: true, Reason: result.IsNew ? null : "duplicate");
        }

        await transport.SubmitRemoteAsync(op);
        // seq unknown until the owner sequences it — the echo
        // broadcast carries it; -1 = "forwarded, watch the stream".
        return new OpAck(op.ClientSeq, -1, Accepted: true, Reason: "forwarded");
    }

    public async Task Presence(PresenceUpdate update)
    {
        // Guests can't paint cursors on owned docs they can't even
        // join (viewers/members/link-holders can — read-only by nature).
        if (await EffectiveRole(update.DocId,
                Context.Items["grant"] as string) is null) return;
        var room = rooms.GetOrCreate(update.DocId);
        // Tracker stores every update (join snapshot stays fresh) and
        // rate-limits the fanout — a spammy client can't flood the room.
        // Name is stamped only while the session is alive — a dead
        // token's cursor must not keep wearing the login it had at
        // connect time.
        var named = Context.Items["token"] is string t &&
            await users.ResolveAsync(t) is { } w
            ? update with { Name = w.login }
            : update;
        if (room.Presence.Update(update.ClientId, named, DateTimeOffset.UtcNow))
            // Goes through the transport so OTHER instances see it too
            // (T-12). The client filters its own clientId, so group
            // fanout instead of OthersInGroup is fine.
            await transport.PublishPresenceAsync(
                new PresenceBroadcast(update.ClientId, named));
    }

    /// <summary>Socket died — kill the cursor now instead of letting it
    /// ghost for the full TTL.</summary>
    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        opLimit.Drop(Context.ConnectionId);
        foreach (var (docId, clientId) in rooms.UntrackConnection(Context.ConnectionId))
            await Clients.Group(docId)
                .SendAsync("presence-left", new PresenceLeft(docId, clientId));
        await base.OnDisconnectedAsync(exception);
    }
}
