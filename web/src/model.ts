// Client mirror of Core/Model/Document.cs (T-3 semantics, T-8 consumer).
// Same LWW registers: objId → prop → {value, seq}; existence =
// createSeq vs deleteSeq. Apply is order-agnostic + idempotent — a
// replayed journal tail or a duplicated broadcast is a no-op by
// construction, exactly like the server.
//
// Registers are nested by object — objects() is O(total regs), which
// matters at 10k objects (a flat scan-per-object was O(n²)).

import type { OpBroadcast } from './protocol'

export interface CanvasObject {
  id: string
  kind: string
  z: string
  props: Record<string, unknown>
}

// Snapshot wire shape (camelCase over SignalR JsonProtocol).
export interface SnapshotObject {
  id: string
  kind: string
  z: string
  props: Record<string, unknown>
}

interface Reg { v: unknown; seq: number }
interface Life { cseq: number; dseq: number }

const KIND = '_kind'
const Z = '_z'

export class DocModel {
  lastSeq = 0
  /** Bumped on every mutation — the SceneIndex rebuilds lazily on it. */
  version = 0
  private readonly regs = new Map<string, Map<string, Reg>>()
  private readonly life = new Map<string, Life>()

  apply(op: OpBroadcast): void {
    const p = op.payload as Record<string, unknown>
    const id = p['id'] as string
    switch (op.type) {
      case 'Create': {
        const l = this.lifeOf(id)
        l.cseq = Math.max(l.cseq, op.seq)
        this.write(id, KIND, p['kind'], op.seq)
        if (p['z'] !== undefined) this.write(id, Z, p['z'], op.seq)
        const props = p['props'] as Record<string, unknown> | undefined
        if (props) for (const k in props) this.write(id, k, props[k], op.seq)
        break
      }
      case 'Patch': {
        const props = p['props'] as Record<string, unknown>
        for (const k in props) this.write(id, k, props[k], op.seq)
        break
      }
      case 'Reorder':
        this.write(id, Z, p['z'], op.seq)
        break
      case 'Delete': {
        const l = this.lifeOf(id)
        l.dseq = Math.max(l.dseq, op.seq)
        break
      }
    }
    // lastSeq tracks REAL server seqs only — optimistic ops carry
    // fractional temps and must never leak into the join contract
    // (LastSeq is a long on the wire; a fraction would break it).
    if (Number.isInteger(op.seq) && op.seq > this.lastSeq) this.lastSeq = op.seq
    this.version++
  }

  /** Rehydrate from a server snapshot (T-5): every register lands at
   * seq=snapshotSeq, so ops ≤ snapshotSeq lose by LWW and the tail
   * applies on top. Tombstones below the snapshot are gone for good —
   * same contract as Document.Restore on the server. */
  restore(objects: SnapshotObject[], seq: number): void {
    this.regs.clear()
    this.life.clear()
    for (const o of objects) {
      this.life.set(o.id, { cseq: seq, dseq: 0 })
      this.write(o.id, KIND, o.kind, seq)
      this.write(o.id, Z, o.z, seq)
      for (const k in o.props) this.write(o.id, k, o.props[k], seq)
    }
    if (seq > this.lastSeq) this.lastSeq = seq
    this.version++
  }

  /** Dev-only perf harness (T-8): inject synthetic objects WITHOUT
   * touching lastSeq — ghosts carry seq=0 and never collide with
   * server ops (private `ghost-` id namespace). */
  debugFill(count: number, area = 4000): void {
    for (let i = 0; i < count; i++) {
      const id = `ghost-${i}`
      this.life.set(id, { cseq: 0, dseq: -1 }) // 0 > -1 → visible
      this.write(id, KIND, 'rect', 0)
      this.write(id, Z, `g${String(i).padStart(8, '0')}`, 0)
      const props: Record<string, unknown> = {
        x: (i * 37) % area,
        y: ((i * 91) % area),
        w: 40 + (i % 5) * 12,
        h: 30 + (i % 7) * 9,
        fill: `hsl(${i % 360} 60% 55%)`,
      }
      for (const k in props) this.write(id, k, props[k], 0)
    }
    this.version++
  }

  clearGhosts(): void {
    for (const id of this.life.keys()) // Map.delete during iteration is legal
      if (id.startsWith('ghost-')) {
        this.life.delete(id)
        this.regs.delete(id)
      }
    this.version++
  }

  /** Visible objects in render order: createSeq > deleteSeq, sorted
   * by (z, id) — deterministic on every replica. */
  objects(): CanvasObject[] {
    const out: CanvasObject[] = []
    for (const [id, l] of this.life) {
      if (l.cseq <= l.dseq) continue
      const regs = this.regs.get(id)
      const kind = regs?.get(KIND)?.v as string | undefined
      if (kind === undefined) continue // regs exist but no winning create
      const z = (regs?.get(Z)?.v as string | undefined) ?? ''
      const props: Record<string, unknown> = {}
      for (const [prop, reg] of regs ?? [])
        if (prop !== KIND && prop !== Z) props[prop] = reg.v
      out.push({ id, kind, z, props })
    }
    return out.sort((a, b) =>
      a.z === b.z ? (a.id < b.id ? -1 : 1) : a.z < b.z ? -1 : 1)
  }

  /** Full reset — doc switch drops every register/tombstone (T-19). */
  reset(): void {
    this.regs.clear()
    this.life.clear()
    this.lastSeq = 0
    this.version++
  }

  objectCount(): number {
    let n = 0
    for (const l of this.life.values()) if (l.cseq > l.dseq) n++
    return n
  }

  private lifeOf(id: string): Life {
    let l = this.life.get(id)
    if (!l) this.life.set(id, (l = { cseq: 0, dseq: 0 }))
    return l
  }

  private write(id: string, prop: string, v: unknown, seq: number): void {
    let obj = this.regs.get(id)
    if (!obj) this.regs.set(id, (obj = new Map()))
    const cur = obj.get(prop)
    if (cur && seq <= cur.seq) return // LWW: older/equal loses → idempotent
    obj.set(prop, { v, seq })
  }
}
