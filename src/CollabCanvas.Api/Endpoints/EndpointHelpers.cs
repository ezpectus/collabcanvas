using StackExchange.Redis;

namespace CollabCanvas.Api.Endpoints;

/// Shared per-request authorization for the endpoint modules —
/// the HTTP twin of DocumentHub.EffectiveRole. Same precedence,
/// same tombstone-first rule; the two must never drift apart.
internal static class Authz
{
    internal static string? Bearer(HttpRequest req)
    {
        var h = req.Headers.Authorization.ToString();
        if (h.StartsWith("Bearer ", StringComparison.Ordinal))
            return h["Bearer ".Length..];
        var q = req.Query["token"].ToString();
        return string.IsNullOrEmpty(q) ? null : q;
    }

    /// T-26 stage 2: caller's role on a doc, same rule as the hub —
    /// unowned → Editor (legacy open), owned → membership or null.
    internal static async Task<Auth.RoomRole?> CallerRole(
        Auth.MembershipStore members,
        Auth.UserStore users,
        HttpRequest req, string docId, object? grant = null)
    {
        // Dead doc denies everything — checked before membership so a
        // destroyed doc can't resurrect via the legacy-open fallback.
        if (await members.IsDeadAsync(docId)) return null;
        // Same precedence as the hub: member > link > legacy-open.
        // A viewer grant must never downgrade a member's real role.
        if (await users.ResolveAsync(Bearer(req)) is { } who &&
            await members.RoleOfAsync(docId, who.login) is { } m)
            return m;
        var g = grant?.ToString();
        if (!string.IsNullOrEmpty(g) &&
            await members.LinkRoleAsync(docId, g) is { } link)
            return link;
        return await members.IsOwnedAsync(docId)
            ? null : Auth.RoomRole.Editor;
    }
}
