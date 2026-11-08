using System.Text.Json;
using CollabCanvas.Core.Protocol;

namespace CollabCanvas.Core.Model;

/// <summary>
/// Document state — the apply-semantics heart (T-3).
///
/// Model: every object property (incl. reserved "_kind"/"_z") is an
/// LWW register keyed (objId, prop) holding (value, seq). Ops never
/// carry timestamps — the server's seq IS the order. Result:
/// apply is order-agnostic and idempotent by construction, so every
/// replica replaying the same op set converges to the same state.
///
/// Existence is LWW too: createSeq vs deleteSeq per object —
/// a patch can never resurrect a deleted object, only a new create
/// with higher seq can.
/// </summary>
public sealed class Document
{
    public const string KindKey = "_kind";
    public const string ZKey = "_z";

    private readonly Dictionary<(string ObjId, string Prop), JsonElement> _props = new();
    private readonly Dictionary<(string ObjId, string Prop), long> _propSeq = new();
    private readonly Dictionary<string, long> _createSeq = new();
    private readonly Dictionary<string, long> _deleteSeq = new();

    public long LastSeq { get; private set; }

    /// <summary>Apply one sequenced op. Idempotent: re-applying is a
    /// no-op because every write requires seq > current register seq.</summary>
    public void Apply(OpBroadcast op)
    {
        var id = op.Payload.GetProperty("id").GetString()
            ?? throw new ArgumentException($"{op.Type} op seq={op.Seq} has no id");

        switch (op.Type)
        {
            case OpType.Create:
                _createSeq[id] = Math.Max(_createSeq.GetValueOrDefault(id), op.Seq);
                WriteProp(id, KindKey, op.Payload.GetProperty("kind"), op.Seq);
                if (op.Payload.TryGetProperty("z", out var z))
                    WriteProp(id, ZKey, z, op.Seq);
                if (op.Payload.TryGetProperty("props", out var props))
                    foreach (var p in props.EnumerateObject())
                        WriteProp(id, p.Name, p.Value, op.Seq);
                break;
            case OpType.Patch:
                foreach (var p in op.Payload.GetProperty("props").EnumerateObject())
                    WriteProp(id, p.Name, p.Value, op.Seq);
                break;
            case OpType.Reorder:
                WriteProp(id, ZKey, op.Payload.GetProperty("z"), op.Seq);
                break;
            case OpType.Delete:
                _deleteSeq[id] = Math.Max(_deleteSeq.GetValueOrDefault(id), op.Seq);
                break;
        }
        if (op.Seq > LastSeq) LastSeq = op.Seq;
    }

    private void WriteProp(string id, string prop, JsonElement value, long seq)
    {
        var key = (id, prop);
        if (seq <= _propSeq.GetValueOrDefault(key)) return; // LWW: older/same loses — makes re-apply a no-op
        _props[key] = value.Clone();
        _propSeq[key] = seq;
    }

    /// <summary>Visible objects: created after last delete.
    /// Sorted by (zKey, id) — deterministic render/hit order on every
    /// replica regardless of apply order.</summary>
    public IEnumerable<CanvasObject> Objects()
    {
        foreach (var (id, cseq) in _createSeq)
        {
            if (cseq <= _deleteSeq.GetValueOrDefault(id)) continue;
            var props = new Dictionary<string, JsonElement>();
            string? kind = null;
            var z = "";
            foreach (var ((oid, prop), val) in _props)
            {
                if (oid != id) continue;
                if (prop == KindKey) kind = val.GetString();
                else if (prop == ZKey) z = val.GetString() ?? "";
                else props[prop] = val;
            }
            if (kind is null) continue; // props exist but never a winning create
            yield return new CanvasObject(id, kind, z, props);
        }
    }

    /// <summary>Deterministic snapshot — two replicas holding the same
    /// writes produce byte-identical JSON. Used by convergence tests
    /// and T-5 snapshot persistence.</summary>
    public string Snapshot() =>
        JsonSerializer.Serialize(Objects().OrderBy(o => o.Z, StringComparer.Ordinal)
            .ThenBy(o => o.Id, StringComparer.Ordinal)
            .Select(o => new { o.Id, o.Kind, o.Z, Props = o.Props.OrderBy(p => p.Key, StringComparer.Ordinal) }));
}

public sealed record CanvasObject(
    string Id,
    string Kind,
    string Z,
    IReadOnlyDictionary<string, JsonElement> Props);
