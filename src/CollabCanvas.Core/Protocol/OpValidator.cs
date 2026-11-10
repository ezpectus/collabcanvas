using System.Text.Json;
using System.Text.RegularExpressions;

namespace CollabCanvas.Core.Protocol;

/// <summary>
/// Input validation for untrusted ops (T-13). The room applies ANY
/// payload — a malformed op would either throw inside the lock
/// (poisoning the submit path) or land in the journal forever.
/// Validation is transport-side (hub calls it before Room.Submit):
/// the room stays pure, garbage stays out of the durable log.
///
/// Limits are generous but bounded — a legit client never drafts a
/// 1MB prop bag or a 100k-point path client-side.
/// </summary>
public static partial class OpValidator
{
    public const int MaxPayloadBytes = 64 * 1024;
    public const int MaxProps = 64;
    public const int MaxTextLen = 4096;
    public const int MaxPoints = 4096;
    public const int MaxIdLen = 64;

    private static readonly string[] Kinds =
        ["rect", "ellipse", "line", "text", "path", "image"];

    [GeneratedRegex("^[0-9A-Za-z._-]{1,64}$")]
    private static partial Regex IdRe();
    [GeneratedRegex("^[0-9A-Za-z]{1,64}$")]
    private static partial Regex ZRe();

    /// <summary>Rejection reason, or null when the op is clean.</summary>
    public static string? Validate(OpSubmit op)
    {
        if (!IdRe().IsMatch(op.DocId)) return "bad docId";
        if (!IdRe().IsMatch(op.ClientId)) return "bad clientId";
        if (op.ClientSeq < 0) return "bad clientSeq";

        var raw = op.Payload.GetRawText();
        if (raw.Length > MaxPayloadBytes) return "payload too large";
        if (!op.Payload.TryGetProperty("id", out var idEl)
            || idEl.ValueKind != JsonValueKind.String)
            return "missing id";
        var id = idEl.GetString()!;
        if (!IdRe().IsMatch(id)) return "bad object id";

        switch (op.Type)
        {
            case OpType.Create:
                if (!op.Payload.TryGetProperty("kind", out var k)
                    || k.ValueKind != JsonValueKind.String
                    || !Kinds.Contains(k.GetString()))
                    return "bad kind";
                if (op.Payload.TryGetProperty("z", out var z)
                    && !ValidZ(z)) return "bad z";
                if (op.Payload.TryGetProperty("props", out var cp))
                    return ValidateProps(cp);
                return null;
            case OpType.Patch:
                if (!op.Payload.TryGetProperty("props", out var pp)
                    || pp.ValueKind != JsonValueKind.Object)
                    return "missing props";
                return ValidateProps(pp);
            case OpType.Reorder:
                return op.Payload.TryGetProperty("z", out var rz) && ValidZ(rz)
                    ? null : "bad z";
            case OpType.Delete:
                return null;
            default:
                return "bad type";
        }
    }

    private static bool ValidZ(JsonElement z) =>
        z.ValueKind == JsonValueKind.String
        && ZRe().IsMatch(z.GetString()!)
        && z.GetString()![^1] != '0'; // FractionalIndex invariant

    private static string? ValidateProps(JsonElement props)
    {
        if (props.ValueKind != JsonValueKind.Object) return "props not object";
        var n = 0;
        foreach (var p in props.EnumerateObject())
        {
            if (++n > MaxProps) return "too many props";
            if (p.Name.Length > MaxIdLen) return "prop name too long";
            // Size caps live here so a Patch can't smuggle what a
            // Create couldn't: long text and huge point arrays were
            // previously checked only on the create path (bot catch).
            if (p.NameEquals("text") && p.Value.ValueKind == JsonValueKind.String
                && p.Value.GetString()!.Length > MaxTextLen)
                return "text too long";
            if (p.NameEquals("points") && p.Value.ValueKind == JsonValueKind.Array
                && p.Value.GetArrayLength() > MaxPoints)
                return "too many points";
        }
        return null;
    }
}
