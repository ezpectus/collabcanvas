using StackExchange.Redis;

namespace CollabCanvas.Api.Auth;

/// T-26 stage 2: per-doc roles — the authorization boundary.
/// Roles live OUTSIDE the document object/LWW props (a doc Patch
/// must never be able to mint permissions). Keys:
///   doc:{id}:members    hash login → "owner|admin|editor|viewer"
///   user:{login}:docs   set of docIds (for the /docs listing)
///
/// Ownership model (design §rollout-2):
/// - A doc becomes OWNED only via POST /docs by a signed-in user
///   (creator = owner). Implicit join of an unowned doc keeps the
///   legacy open behavior — no first-claim land-grab: signing in
///   must not let you steal docs others are editing anonymously.
/// - Owned doc + no membership → join denied, ops denied.
/// - Unowned doc → everyone editor (legacy; closing that is the
///   link-grant stage, not this one).
public enum RoomRole { Viewer = 0, Editor = 1, Admin = 2, Owner = 3 }

public sealed class MembershipStore(IConnectionMultiplexer redis)
{
    private IDatabase Db => redis.GetDatabase();

    private static string MKey(string docId) => $"doc:{docId}:members";
    private static string DKey(string login) => $"user:{login}:docs";

    /// <summary>Any member entry = the doc is owned (enforced).
    /// Tracked in the owned:docs set — one SISMEMBER, not a hash scan.</summary>
    public Task<bool> IsOwnedAsync(string docId) =>
        Db.SetContainsAsync("owned:docs", docId);

    public async Task<RoomRole?> RoleOfAsync(string docId, string login)
    {
        var v = await Db.HashGetAsync(MKey(docId), login);
        return v.IsNullOrEmpty ? null : Parse(v.ToString());
    }

    /// <summary>Grant a role; also index the doc for the member's
    /// /docs listing and mark the doc owned.</summary>
    public async Task SetRoleAsync(
        string docId, string login, RoomRole role)
    {
        await Db.HashSetAsync(MKey(docId), login, Name(role));
        await Db.SetAddAsync(DKey(login), docId);
        await Db.SetAddAsync("owned:docs", docId);
    }

    public async Task RemoveRoleAsync(string docId, string login)
    {
        await Db.HashDeleteAsync(MKey(docId), login);
        await Db.SetRemoveAsync(DKey(login), docId);
        // Last member gone → the doc is unowned/open again. Rare and
        // honest: deleting your only member must not brick the doc.
        if (await Db.HashLengthAsync(MKey(docId)) == 0)
            await Db.SetRemoveAsync("owned:docs", docId);
    }

    public async Task<Dictionary<string, RoomRole>> MembersAsync(string docId)
    {
        var h = await Db.HashGetAllAsync(MKey(docId));
        return h.ToDictionary(
            e => e.Name.ToString(), e => Parse(e.Value.ToString()));
    }

    /// <summary>Docs this login is a member of (authed /docs).</summary>
    public async Task<string[]> DocsOfAsync(string login)
    {
        var s = await Db.SetMembersAsync(DKey(login));
        return s.Select(v => v.ToString()).ToArray();
    }

    // ---- T-26 stage 3: link grants -----------------------------------
    // doc:{id}:links  hash token → "viewer|editor". A link is a bearer
    // capability: owner/admin are NEVER grantable by link (design §links
    // — a leaked owner-link = handing the doc away).
    private static string LKey(string docId) => $"doc:{docId}:links";

    public async Task<string> NewLinkAsync(
        string docId, RoomRole role, TimeSpan? ttl = null)
    {
        var token = Convert.ToBase64String(
            System.Security.Cryptography.RandomNumberGenerator.GetBytes(18))
            .Replace('+', '-').Replace('/', '_'); // 24-char url-safe
        // value = "role" or "role|expiryUnix" — old links without a
        // pipe stay valid forever (back-compat).
        var value = ttl is { } t
            ? $"{Name(role)}|{DateTimeOffset.UtcNow.Add(t).ToUnixTimeSeconds()}"
            : Name(role);
        await Db.HashSetAsync(LKey(docId), token, value);
        return token;
    }

    /// Parses "role[|expiry]"; an expired grant deletes itself
    /// lazily on first touch and resolves to nothing.
    private async Task<RoomRole?> ReadLink(string docId, string token,
        string raw)
    {
        var pipe = raw.IndexOf('|');
        if (pipe < 0) return Parse(raw);
        if (long.TryParse(raw[(pipe + 1)..], out var exp) &&
            DateTimeOffset.UtcNow.ToUnixTimeSeconds() < exp)
            return Parse(raw[..pipe]);
        await Db.HashDeleteAsync(LKey(docId), token);
        return null;
    }

    public async Task<RoomRole?> LinkRoleAsync(string docId, string token)
    {
        var v = await Db.HashGetAsync(LKey(docId), token);
        return v.IsNullOrEmpty ? null : await ReadLink(docId, token, v.ToString()!);
    }

    public Task RemoveLinkAsync(string docId, string token) =>
        Db.HashDeleteAsync(LKey(docId), token);

    public async Task<Dictionary<string, RoomRole>> LinksAsync(string docId)
    {
        var h = await Db.HashGetAllAsync(LKey(docId));
        var live = new Dictionary<string, RoomRole>();
        foreach (var e in h)
            if (await ReadLink(docId, e.Name.ToString(), e.Value.ToString()!)
                is { } r)
                live[e.Name.ToString()] = r;
        return live;
    }

    // ---- hard delete --------------------------------------------------
    // Tombstone: without it a destroyed doc resurrects — ownership
    // checks fall through to the "unowned = open" legacy branch and
    // anyone re-joins as editor. The dead marker blocks that path and
    // is cleared only if a new owner explicitly claims the same id.
    private static string DeadKey(string docId) => $"doc:{docId}:dead";

    public Task<bool> IsDeadAsync(string docId) =>
        Db.KeyExistsAsync(DeadKey(docId));

    /// <summary>Irreversible: strips members, links, meta, journal,
    /// snapshot, blobs and listings, then leaves the tombstone.
    /// Caller must have verified Owner — there is no undo.</summary>
    public async Task DestroyAsync(string docId)
    {
        var db = Db;
        var membersH = await db.HashGetAllAsync(MKey(docId));
        var blobs = await db.SetMembersAsync($"doc:{docId}:blobs");
        var batch = db.CreateBatch();
        var t = new List<Task>();
        foreach (var m in membersH)
            t.Add(batch.SetRemoveAsync(DKey(m.Name!), docId));
        foreach (var b in blobs)
        {
            t.Add(batch.KeyDeleteAsync($"blob:{b}"));
            t.Add(batch.KeyDeleteAsync($"blob:{b}:meta"));
        }
        foreach (var k in new[]
        {
            MKey(docId), LKey(docId), $"doc:{docId}:meta",
            $"doc:{docId}:blobs", $"doc:{docId}:ops",
            $"doc:{docId}:snap", $"doc:{docId}:owner",
        })
            t.Add(batch.KeyDeleteAsync(k));
        t.Add(batch.SetRemoveAsync("docs", docId));
        t.Add(batch.SetRemoveAsync("owned:docs", docId));
        t.Add(batch.StringSetAsync(DeadKey(docId), "1"));
        batch.Execute();
        await Task.WhenAll(t);
    }

    /// <summary>Re-claiming a dead id (fresh POST /docs by a new
    /// owner) must lift the tombstone — the old doc is gone, the id
    /// is just a name.</summary>
    public Task ResurrectAsync(string docId) =>
        Db.KeyDeleteAsync(DeadKey(docId));

    /// <summary>All owned doc ids — /docs guest filtering subtracts
    /// these from the discovery set.</summary>
    public async Task<HashSet<string>> OwnedDocIdsAsync()
    {
        var s = await Db.SetMembersAsync("owned:docs");
        return s.Select(v => v.ToString()).ToHashSet();
    }

    public static string Name(RoomRole r) => r switch
    {
        RoomRole.Owner => "owner", RoomRole.Admin => "admin",
        RoomRole.Editor => "editor", _ => "viewer",
    };

    public static RoomRole Parse(string s) => s switch
    {
        "owner" => RoomRole.Owner, "admin" => RoomRole.Admin,
        "editor" => RoomRole.Editor, _ => RoomRole.Viewer,
    };

    // NOT "TryParse" — minimal-API binding probes injected types for a
    // static TryParse(string,out T) and crashes on a signature it
    // doesn't recognize. Named so it can't collide with the convention.
    public static RoomRole? ParseRole(string? s) => s switch
    {
        "owner" => RoomRole.Owner, "admin" => RoomRole.Admin,
        "editor" => RoomRole.Editor, "viewer" => RoomRole.Viewer,
        _ => null,
    };
}
