using BCrypt.Net;
using StackExchange.Redis;

namespace CollabCanvas.Api.Auth;

/// T-26 stage 1: users + sessions in Redis. Deliberately NO JWT —
/// server-side tokens are revocable and keep the hub ignorant of
/// crypto. Keys:
///   user:{login}      hash { id, hash }         — account
///   sess:{token}      string userId, TTL 7d     — session (refresh
///                                                     on resolve)
///   user:id:{id}      string login              — id→login lookup
/// Guests still join/edit (stage-2 wires roles); a resolved userId
/// only upgrades presence display + future membership checks.
public sealed class UserStore(IConnectionMultiplexer redis)
{
    private IDatabase Db => redis.GetDatabase();

    public enum RegResult { Ok, Taken, BadInput }

    public async Task<(RegResult res, string? token)> RegisterAsync(
        string login, string password)
    {
        if (!ValidLogin(login) || password.Length < 6)
            return (RegResult.BadInput, null);
        var key = $"user:{login}";
        if (await Db.KeyExistsAsync(key)) return (RegResult.Taken, null);
        var id = Guid.NewGuid().ToString("N");
        // WorkFactor 11 ≈ 60-80ms — login-throttling makes brute
        // force impractical; plaintext is never stored or logged.
        var hash = BCrypt.Net.BCrypt.HashPassword(password, 11);
        await Db.HashSetAsync(key, [
            new("id", id), new("hash", hash)]);
        await Db.StringSetAsync($"user:id:{id}", login);
        return (RegResult.Ok, await NewSession(id));
    }

    public async Task<string?> LoginAsync(string login, string password)
    {
        var h = await Db.HashGetAsync($"user:{login}", "hash");
        if (h.IsNullOrEmpty ||
            !BCrypt.Net.BCrypt.Verify(password, h.ToString()))
            return null;
        var id = await Db.HashGetAsync($"user:{login}", "id");
        return await NewSession(id!);
    }

    /// Session → (userId, login). Sliding TTL — active sessions
    /// live, abandoned ones die in 7d.
    public async Task<(string id, string login)?> ResolveAsync(
        string? token)
    {
        if (string.IsNullOrEmpty(token)) return null;
        var key = $"sess:{token}";
        var id = await Db.StringGetAsync(key);
        if (id.IsNullOrEmpty) return null;
        await Db.KeyExpireAsync(key, TimeSpan.FromDays(7));
        var login = await Db.StringGetAsync($"user:id:{id}");
        return login.IsNullOrEmpty ? null
            : (id.ToString(), login.ToString()!);
    }

    public async Task LogoutAsync(string token)
    {
        var id = await Db.StringGetAsync($"sess:{token}");
        await Db.KeyDeleteAsync($"sess:{token}");
        if (!id.IsNullOrEmpty)
            await Db.SetRemoveAsync(SSet(id!), token);
    }

    // user:{id}:sess — set of live tokens so a password change can
    // revoke every OTHER session while keeping the caller's. Stale
    // entries (TTL-expired) just miss on delete — harmless.
    private static string SSet(string id) => $"user:{id}:sess";

    /// <summary>Verify old hash → rehash → kill all sessions except
    /// keepToken. A changed password must cut off whoever holds an
    /// old token; the changer stays logged in.</summary>
    public async Task<bool> ChangePasswordAsync(
        string id, string login,
        string oldPw, string newPw, string keepToken)
    {
        var h = await Db.HashGetAsync($"user:{login}", "hash");
        if (h.IsNullOrEmpty ||
            !BCrypt.Net.BCrypt.Verify(oldPw, h.ToString()))
            return false;
        await Db.HashSetAsync($"user:{login}", "hash",
            BCrypt.Net.BCrypt.HashPassword(newPw, 11));
        var toks = await Db.SetMembersAsync(SSet(id));
        await Db.KeyDeleteAsync(SSet(id));
        await Db.SetAddAsync(SSet(id), keepToken);
        foreach (var t in toks)
            if (t.ToString() != keepToken)
                await Db.KeyDeleteAsync($"sess:{t}");
        return true;
    }

    private async Task<string> NewSession(string userId)
    {
        var token = Convert.ToBase64String(
            System.Security.Cryptography.RandomNumberGenerator.GetBytes(24))
            .Replace('+', '-').Replace('/', '_');
        await Db.StringSetAsync($"sess:{token}", userId,
            TimeSpan.FromDays(7));
        await Db.SetAddAsync(SSet(userId), token);
        return token;
    }

    // Deliberately narrow: no unicode gymnastics in logins — keeps
    // /docs membership lists and presence names sane.
    private static bool ValidLogin(string l) =>
        l.Length is >= 2 and <= 32 && l.All(
            c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_');
}
