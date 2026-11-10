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
