// Editing tools (T-9, extended T-14): select/move/resize/rotate/
// create/delete + multi-select (marquee & shift-click), duplicate,
// z-order front/back. All mutations go through Session.submit →
// optimistic local apply + server op — one code path, LWW reconciles.
//
// Drag semantics unchanged: local apply per frame (free), wire Patch
// throttled 80ms, final flush on mouseup. Deltas apply to props as of
// mouseDown — no float drift, no mid-drag hijack by foreign patches.

import { boundsOf, computeResize, num, quadOf, simplifyPoints,
  type BBox } from './geometry'
import type { CanvasObject } from './model'
import { FractionalIndex } from './fractionalIndex'
import { SceneIndex } from './quadtree'
import type { Session } from './session'
import type { OpType } from './protocol'

export type Tool = 'select' | 'rect' | 'ellipse' | 'line' | 'text' | 'path'

/** Rotated quad for selection outlines: [TL, TR, BR, BL] in world. */
export type Quad = { x: number; y: number }[]

interface Drag {
  mode: 'move' | 'resize' | 'rotate' | 'create' | 'marquee' | 'pan-hint'
    | 'point' | 'gresize' | 'grotate'
  startX: number
  startY: number
  /** orig props per dragged object — deltas apply to these */
  orig: Map<string, Record<string, unknown>>
  center: { x: number; y: number } | null // rotate pivot
  moved: boolean
  /** T-16: which of the 8 handles grabbed (index into HANDLE_DIRS) */
  handle: number
  localCreate?: { id: string; z: string }
}


/** One document op for the undo log (T-17). */
type WireOp = { type: OpType; payload: Record<string, unknown> }

export class Editor {
  tool: Tool = 'select'
  readonly selected = new Set<string>()
  /** T-22: current brush — new objects take it, applyColor repaints
   *  the selection. fill for closed shapes, stroke for line/path. */
  color = '#3d5af1'
  /** T-23: snap-to-grid, toggled by G. Snaps the pointer, so create,
   *  move and resize all align — the wire ops carry snapped values. */
  snap = false
  /** T-30: alignment guides active during a move-drag, world coords.
   *  Renderer reads them every frame; cleared on mouseUp. */
  guides: { axis: 'v' | 'h'; pos: number }[] = []
  private grid(v: number): number { return this.snap ? Math.round(v / 10) * 10 : v }
  /** Text object asking for the inline editor (dblclick / click-place).
   *  The overlay lives in React-land — the editor only flags the id. */
  private wantEdit: string | null = null
  private drag: Drag | null = null
  private marquee: { x0: number; y0: number; x1: number; y1: number } | null = null
  private lastPatch = 0
  // T-17: per-client undo as compensating ops. Each entry stores the
  // ops that REVERSE an action and the ops that redo it — undo is a
  // fresh submit, so it wins LWW and replicates like any edit. The
  // journal stays append-only; no protocol changes.
  private readonly undoStack: { inv: WireOp[]; fwd: WireOp[] }[] = []
  private readonly redoStack: { inv: WireOp[]; fwd: WireOp[] }[] = []

  constructor(
    private readonly session: Session,
    private readonly index: SceneIndex,
    private readonly redraw: () => void,
  ) {}

  private objects(): CanvasObject[] { return this.session.model.objects() }
  private find(id: string): CanvasObject | undefined {
    return this.objects().find((o) => o.id === id)
  }

  /** Selection outlines for the renderer: rotated quad per object. */
  selectionQuads(): Quad[] {
    const out: Quad[] = []
    for (const id of this.selected) {
      const o = this.find(id)
      const b = o && boundsOf(o)
      if (b) out.push(quadOf(b, num(o!.props, 'rot')))
    }
    return out
  }

  marqueeRect(): BBox | null { return this.marquee }

  /** Consume a pending inline-edit request (dblclick on text, or a
   *  click-placed new text). Returns null when nothing asked. */
  takeEditRequest(): string | null {
    const id = this.wantEdit
    this.wantEdit = null
    return id
  }

  /** dblclick: text objects open the inline editor, others just select. */
  dblClick(wx: number, wy: number): void {
    const hit = this.index.hitTest(this.session.model, wx, wy)
    if (!hit) return
    this.selected.clear()
    this.selected.add(hit.id)
    if (hit.kind === 'text') this.wantEdit = hit.id
    this.redraw()
  }

  private id(): string { return `o-${Math.random().toString(36).slice(2, 10)}` }

  // --- T-17 undo/redo -----------------------------------------------------
  private recordUndo(inv: WireOp[], fwd: WireOp[]): void {
    this.undoStack.push({ inv, fwd })
    if (this.undoStack.length > 100) this.undoStack.shift()
    this.redoStack.length = 0
  }
  private submitAll(ops: WireOp[]): void {
    for (const o of ops) this.session.submit(o.type, o.payload)
  }
  /** Ctrl+Z: submit the inverses as NEW ops — newest seq wins LWW,
   *  so undo is just another edit to every other client. */
  undo(): void {
    const e = this.undoStack.pop()
    if (!e) return
    this.submitAll(e.inv)
    this.redoStack.push(e)
    this.redraw()
  }
  /** Ctrl+Y / Ctrl+Shift+Z. */
  redo(): void {
    const e = this.redoStack.pop()
    if (!e) return
    this.submitAll(e.fwd)
    this.undoStack.push(e)
    this.redraw()
  }
  /** T-22: repaint the selection with the current brush. Stroke for
   *  line/path, fill otherwise — matches what the renderer reads. */
  applyColor(c: string): void {
    this.color = c
    const inv: WireOp[] = [], fwd: WireOp[] = []
    for (const id of this.selected) {
      const o = this.find(id)
      if (!o) continue
      const key = (o.kind === 'line' || o.kind === 'path') ? 'stroke' : 'fill'
      inv.push({ type: 'Patch', payload: { id, props: { [key]: o.props[key] ?? null } } })
      fwd.push({ type: 'Patch', payload: { id, props: { [key]: c } } })
    }
    if (fwd.length) this.recordUndo(inv, fwd)
    for (const op of fwd) this.session.submit('Patch', op.payload)
  }

  /** Text overlay commit — routed through the editor so undo sees it. */
  commitText(id: string, text: string): void {
    const old = this.find(id)?.props['text']
    this.recordUndo(
      [{ type: 'Patch', payload: { id, props: { text: old ?? null } } }],
      [{ type: 'Patch', payload: { id, props: { text } } }])
    this.session.submit('Patch', { id, props: { text } })
  }

  private topZ(): string {
    const top = this.objects().at(-1)?.z
    return top ? FractionalIndex.after(top) : FractionalIndex.first()
  }

  /** T-16: the 8 handles of a single selected box-kind object, world
   *  coords (corners + edge midpoints of the rotated quad). Line/path
   *  get none — scaling a point set is a different op (honest edge). */
  handlePoints(): { x: number; y: number }[] {
    // T-34: multi-select gets one BR handle on the union box —
    // group scale is proportional from the TL anchor. Only box
    // kinds participate (line/path have no x/y/w/h to scale).
    if (this.selected.size >= 2) {
      let u: BBox | null = null
      for (const oid of this.selected) {
        const o = this.find(oid)
        const b = o && boundsOf(o)
        if (!b || o!.props['x'] === undefined) continue
        u = u ? { x0: Math.min(u.x0, b.x0), y0: Math.min(u.y0, b.y0),
                  x1: Math.max(u.x1, b.x1), y1: Math.max(u.y1, b.y1) } : b
      }
      return u ? [{ x: u.x1, y: u.y1 }] : []
    }
    if (this.selected.size !== 1) return []
    const o = this.find([...this.selected][0]!)
    if (!o) return []
    // T-27: a selected line shows its 2 endpoints — draggable, the only
    // reshape a segment needs. Path keeps no handles (point set).
    if (o.kind === 'line')
      return [{ x: num(o.props, 'x1'), y: num(o.props, 'y1') },
              { x: num(o.props, 'x2'), y: num(o.props, 'y2') }]
    if (o.kind !== 'rect' && o.kind !== 'ellipse'
        && o.kind !== 'text' && o.kind !== 'image') return []
    const b = boundsOf(o)
    if (!b) return []
    const q = quadOf(b, num(o.props, 'rot'))
    const mid = (a: { x: number; y: number }, c: { x: number; y: number }) =>
      ({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 })
    return [q[0]!, mid(q[0]!, q[1]!), q[1]!, mid(q[1]!, q[2]!),
            q[2]!, mid(q[2]!, q[3]!), q[3]!, mid(q[3]!, q[0]!)]
  }

  mouseDown(wx: number, wy: number, scale = 1, shift = false): void {
    wx = this.grid(wx); wy = this.grid(wy)
    if (this.tool !== 'select') { this.createStart(wx, wy); return }

    const hp = this.handlePoints()
    const tol = 8 / scale
    const hi = hp.findIndex(p => Math.abs(wx - p.x) <= tol && Math.abs(wy - p.y) <= tol)
    if (hi >= 0) {
      const o = this.find([...this.selected][0]!)!
      this.drag = {
        mode: this.selected.size >= 2
            ? (shift ? 'grotate' : 'gresize')
          : o.kind === 'line' ? 'point'
          : shift && hi === 4 ? 'rotate' : 'resize',
        startX: wx, startY: wy,
        orig: new Map([...this.selected]
          .map((id) => [id, { ...this.find(id)!.props }])),
        center: this.selected.size >= 2
          ? (() => { // grotate pivot = union-bbox center
              let u: BBox | null = null
              for (const id of this.selected) {
                const b = boundsOf(this.find(id)!)
                if (b) u = u ? { x0: Math.min(u.x0, b.x0),
                                 y0: Math.min(u.y0, b.y0),
                                 x1: Math.max(u.x1, b.x1),
                                 y1: Math.max(u.y1, b.y1) } : b
              }
              return u ? { x: (u.x0 + u.x1) / 2, y: (u.y0 + u.y1) / 2 } : null
            })()
          : shift && hi === 4
          ? { x: (boundsOf(o)!.x0 + boundsOf(o)!.x1) / 2,
              y: (boundsOf(o)!.y0 + boundsOf(o)!.y1) / 2 }
          : null,
        moved: false, handle: hi,
      }
      return
    }

    const hit = this.index.hitTest(this.session.model, wx, wy)
    if (hit && shift) {
      // Shift-click toggles membership.
      if (this.selected.has(hit.id)) this.selected.delete(hit.id)
      else this.selected.add(hit.id)
      this.drag = { mode: 'pan-hint', startX: wx, startY: wy,
                    orig: new Map(), center: null, moved: false, handle: -1 }
    } else if (hit) {
      if (!this.selected.has(hit.id)) { this.selected.clear(); this.selected.add(hit.id) }
      this.drag = {
        mode: 'move', startX: wx, startY: wy,
        orig: new Map([...this.selected]
          .map((id) => [id, { ...this.find(id)!.props }])),
        center: null, moved: false, handle: -1,
      }
    } else {
      // Shift+marquee is additive — same convention as shift-click.
      if (!shift) this.selected.clear()
      this.marquee = { x0: wx, y0: wy, x1: wx, y1: wy }
      this.drag = { mode: 'marquee', startX: wx, startY: wy,
                    orig: new Map(), center: null, moved: false, handle: -1 }
    }
    this.redraw()
  }

  private createStart(wx: number, wy: number): void {
    const id = this.id()
    if (this.tool === 'path') {
      // Local-only while drawing — see T-12: the wire gets one Create.
      const z = this.topZ()
      const props = { points: [{ x: wx, y: wy }], stroke: this.color, lineWidth: 2 }
      this.session.applyLocal('Create', { id, kind: 'path', z, props })
      this.selected.clear(); this.selected.add(id)
      this.drag = { mode: 'create', startX: wx, startY: wy,
                    orig: new Map([[id, props]]), center: null,
                    moved: false, handle: -1, localCreate: { id, z } }
      return
    }
    const props = this.tool === 'line'
      ? { x1: wx, y1: wy, x2: wx, y2: wy, stroke: this.color, lineWidth: 2 }
      : { x: wx, y: wy, w: 1, h: 1, rot: 0,
          fill: this.color, text: this.tool === 'text' ? 'text' : undefined,
          fontSize: 16 }
    this.session.submit('Create', { id, kind: this.tool, z: this.topZ(), props })
    this.selected.clear(); this.selected.add(id)
    this.drag = { mode: 'create', startX: wx, startY: wy,
                  orig: new Map([[id, props]]), center: null, moved: false, handle: -1 }
  }

  mouseMove(wx: number, wy: number, aspect = false, scale = 1): void {
    const d = this.drag
    if (!d) return
    let dx = wx - d.startX
    let dy = wy - d.startY
    d.moved = true

    // T-30: alignment — snap the dragged selection's edges/center to
    // edges/centers of other objects within tolerance. Guides show
    // which edge caught. O(objects×9) per move frame — fine at 10k,
    // revisit if profiling says otherwise.
    this.guides = []
    if (d.mode === 'move') {
      let sb: BBox | null = null
      for (const [oid, orig] of d.orig) {
        const o = this.find(oid)
        const b = o && boundsOf({ ...o, props: orig })
        if (b) sb = sb
          ? { x0: Math.min(sb.x0, b.x0), y0: Math.min(sb.y0, b.y0),
              x1: Math.max(sb.x1, b.x1), y1: Math.max(sb.y1, b.y1) }
          : b
      }
      if (sb) {
        const mine = {
          v: [sb.x0 + dx, (sb.x0 + sb.x1) / 2 + dx, sb.x1 + dx],
          h: [sb.y0 + dy, (sb.y0 + sb.y1) / 2 + dy, sb.y1 + dy],
        }
        const tol = 6 / scale
        let bx = tol + 1, by = tol + 1, gx = 0, gy = 0
        for (const o of this.objects()) {
          if (d.orig.has(o.id)) continue
          const b = boundsOf(o)
          if (!b) continue
          for (const c of [b.x0, (b.x0 + b.x1) / 2, b.x1])
            for (const m of mine.v)
              if (Math.abs(c - m) < Math.abs(bx)) { bx = c - m; gx = c }
          for (const c of [b.y0, (b.y0 + b.y1) / 2, b.y1])
            for (const m of mine.h)
              if (Math.abs(c - m) < Math.abs(by)) { by = c - m; gy = c }
        }
        if (Math.abs(bx) <= tol) { dx += bx; this.guides.push({ axis: 'v', pos: gx }) }
        if (Math.abs(by) <= tol) { dy += by; this.guides.push({ axis: 'h', pos: gy }) }
      }
    }

    if (d.mode === 'marquee') {
      this.marquee = { x0: Math.min(d.startX, wx), y0: Math.min(d.startY, wy),
                       x1: Math.max(d.startX, wx), y1: Math.max(d.startY, wy) }
      this.redraw()
      return
    }

    if (d.mode === 'point') {
      // T-27: endpoint drag — handle 0 = (x1,y1), handle 1 = (x2,y2).
      const [kx, ky] = d.handle === 0 ? ['x1', 'y1'] : ['x2', 'y2']
      for (const [oid] of d.orig)
        this.patchThrottled(oid, { [kx]: wx, [ky]: wy })
      return
    }

    if ((d.mode === 'rotate' || d.mode === 'grotate') && d.center) {
      const a0 = Math.atan2(d.startY - d.center.y, d.startX - d.center.x)
      const a1 = Math.atan2(wy - d.center.y, wx - d.center.x)
      const deg = ((a1 - a0) * 180) / Math.PI
      if (d.mode === 'rotate') {
        for (const [oid, orig] of d.orig)
          this.patchThrottled(oid, { rot: (num(orig, 'rot') + deg + 360) % 360 })
        return
      }
      // grotate: every object swings around the union center; boxes
      // also accumulate their own rot, line/path geometry rotates
      // point-wise (they have no rot prop). rad precomputed once.
      const rad = (deg * Math.PI) / 180, cs = Math.cos(rad), sn = Math.sin(rad)
      const c = d.center
      const spin = (px: number, py: number) => ({
        x: c.x + (px - c.x) * cs - (py - c.y) * sn,
        y: c.y + (px - c.x) * sn + (py - c.y) * cs,
      })
      for (const [oid, orig] of d.orig) {
        const o = this.find(oid)
        if (!o) continue
        if (o.kind === 'line') {
          const p1 = spin(num(orig, 'x1'), num(orig, 'y1'))
          const p2 = spin(num(orig, 'x2'), num(orig, 'y2'))
          this.patchThrottled(oid, { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y })
        } else if (orig['points'] !== undefined) {
          this.patchThrottled(oid, {
            points: (orig['points'] as { x: number; y: number }[])
              .map((p) => spin(p.x, p.y)),
          })
        } else if (orig['x'] !== undefined) {
          const b = boundsOf({ ...o, props: orig })!
          const nc = spin((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2)
          this.patchThrottled(oid, {
            x: nc.x - (b.x1 - b.x0) / 2,
            y: nc.y - (b.y1 - b.y0) / 2,
            rot: (num(orig, 'rot') + deg + 360) % 360,
          })
        }
      }
      return
    }

    if (d.mode === 'gresize') {
      // T-34: scale factor from the union box; TL anchors, BR follows
      // the pointer. Per-axis unless Shift (uniform). Clamp 0.05.
      let gb: BBox | null = null
      const obs = new Map<string, BBox>()
      for (const [oid, orig] of d.orig) {
        const o = this.find(oid)
        const b = o && boundsOf({ ...o, props: orig })
        if (!o || !b || orig['x'] === undefined) continue
        obs.set(oid, b)
        gb = gb ? { x0: Math.min(gb.x0, b.x0), y0: Math.min(gb.y0, b.y0),
                    x1: Math.max(gb.x1, b.x1), y1: Math.max(gb.y1, b.y1) } : b
      }
      if (gb) {
        let sx = (wx - gb.x0) / Math.max(1, gb.x1 - gb.x0)
        let sy = (wy - gb.y0) / Math.max(1, gb.y1 - gb.y0)
        if (aspect) { const s = Math.min(sx, sy); sx = s; sy = s }
        sx = Math.max(0.05, sx); sy = Math.max(0.05, sy)
        for (const [oid, b] of obs) {
          const x0n = gb.x0 + (b.x0 - gb.x0) * sx
          const y0n = gb.y0 + (b.y0 - gb.y0) * sy
          this.patchThrottled(oid, {
            x: x0n, y: y0n,
            w: Math.max(1, (b.x1 - b.x0) * sx),
            h: Math.max(1, (b.y1 - b.y0) * sy),
          })
        }
      }
      return
    }

    for (const [oid, orig] of d.orig) {
      if (d.mode === 'move') {
        this.patchThrottled(oid, {
          x: orig['x'] !== undefined ? num(orig, 'x') + dx : undefined,
          y: orig['y'] !== undefined ? num(orig, 'y') + dy : undefined,
          x1: orig['x1'] !== undefined ? num(orig, 'x1') + dx : undefined,
          y1: orig['y1'] !== undefined ? num(orig, 'y1') + dy : undefined,
          x2: orig['x2'] !== undefined ? num(orig, 'x2') + dx : undefined,
          y2: orig['y2'] !== undefined ? num(orig, 'y2') + dy : undefined,
          points: orig['points'] !== undefined
            ? (orig['points'] as { x: number; y: number }[])
                .map((p) => ({ x: p.x + dx, y: p.y + dy }))
            : undefined,
        })
      } else if (d.mode === 'resize') {
        this.patchThrottled(oid,
          computeResize(orig, d.handle, dx, dy, aspect))
      } else if (d.mode === 'create') {
        if (d.localCreate) {
          const pts = orig['points'] as { x: number; y: number }[]
          const last = pts[pts.length - 1]!
          if ((wx - last.x) ** 2 + (wy - last.y) ** 2 > 2.25) {
            pts.push({ x: wx, y: wy })
            this.session.applyLocal('Patch',
              { id: oid, props: { points: pts } })
            this.redraw()
          }
        } else if (orig['x1'] !== undefined) {
          this.patchThrottled(oid, { x2: wx, y2: wy })
        } else {
          this.patchThrottled(oid, {
            x: Math.min(d.startX, wx), y: Math.min(d.startY, wy),
            w: Math.abs(dx), h: Math.abs(dy),
          })
        }
      }
    }
  }

  mouseUp(): void {
    const d = this.drag
    this.drag = null
    this.guides = []
    if (!d) return

    if (d.mode === 'marquee') {
      const m = this.marquee!
      this.marquee = null
      if (d.moved)
        for (const o of this.objects()) {
          const b = boundsOf(o)
          if (b && !(b.x1 < m.x0 || b.x0 > m.x1 || b.y1 < m.y0 || b.y0 > m.y1))
            this.selected.add(o.id)
        }
      this.redraw()
      return
    }

    if (d.mode === 'create' && !d.moved) {
      for (const oid of d.orig.keys()) {
        if (this.tool === 'text' && !d.localCreate) {
          // Click-place: keep a default-size text and open the editor.
          this.session.submit('Patch', { id: oid, props: { w: 120, h: 24 } })
          this.wantEdit = oid
          const placed = this.find(oid)
          if (placed) this.recordUndo(
            [{ type: 'Delete', payload: { id: oid } }],
            [{ type: 'Create', payload: {
              id: oid, kind: 'text', z: placed.z, props: { ...placed.props } } }])
          continue
        }
        if (d.localCreate) this.session.applyLocal('Delete', { id: oid })
        else this.session.submit('Delete', { id: oid })
        this.selected.delete(oid)
      }
    } else if (d.localCreate) {
      // T-21: simplify before the wire — raw mouse resolution is
      // noise; ~1wu tolerance keeps the shape, drops the payload.
      const origProps = d.orig.get(d.localCreate.id)!
      const pts = origProps['points'] as { x: number; y: number }[]
      const props = { ...origProps, points: simplifyPoints(pts, 1) }
      this.session.submit('Create', {
        id: d.localCreate.id, kind: 'path', z: d.localCreate.z, props })
      this.recordUndo(
        [{ type: 'Delete', payload: { id: d.localCreate.id } }],
        [{ type: 'Create', payload: {
          id: d.localCreate.id, kind: 'path', z: d.localCreate.z, props } }])
    } else if (d.moved && d.mode === 'create') {
      // Shape placed: the Create already went on the wire at mousedown;
      // undo removes the object, redo recreates it with final props.
      for (const oid of d.orig.keys()) {
        const o = this.find(oid)
        if (!o) continue
        this.recordUndo(
          [{ type: 'Delete', payload: { id: oid } }],
          [{ type: 'Create', payload: {
            id: oid, kind: o.kind, z: o.z, props: { ...o.props } } }])
      }
    } else if (d.moved) {
      // Gesture commit (move/resize/rotate): one undo entry covering
      // every touched object — inverse restores drag-start props.
      const inv: WireOp[] = [], fwd: WireOp[] = []
      for (const [oid, orig] of d.orig) {
        const props = this.find(oid)?.props
        if (!props) continue
        const flush: Record<string, unknown> = {}
        for (const k of ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2', 'rot', 'points'])
          if (props[k] !== undefined) flush[k] = props[k]
        this.session.submit('Patch', { id: oid, props: flush })
        inv.push({ type: 'Patch', payload: { id: oid, props: { ...orig } } })
        fwd.push({ type: 'Patch', payload: { id: oid, props: flush } })
      }
      if (fwd.length) this.recordUndo(inv, fwd)
    }
    this.redraw()
  }

  /** Keys that mutate the document or selection. */
  key(key: string, ctrl = false, shift = false, alt = false): void {
    if (ctrl && (key === 'z' || (key === 'Z' && !shift))) { this.undo(); return }
    if (ctrl && (key === 'y' || (key === 'Z' && shift))) { this.redo(); return }
    if (key === 'Delete' || key === 'Backspace') {
      // Compensating-op undo: inverse = Create with the pre-delete state.
      const inv: WireOp[] = [], fwd: WireOp[] = []
      for (const id of this.selected) {
        const o = this.find(id)
        if (!o) continue
        inv.push({ type: 'Create', payload: {
          id, kind: o.kind, z: o.z, props: { ...o.props } } })
        fwd.push({ type: 'Delete', payload: { id } })
      }
      if (fwd.length) { this.recordUndo(inv, fwd); this.submitAll(fwd) }
      this.selected.clear()
      this.redraw()
      return
    }
    if (key === 'Escape') {
      // Esc mid-gesture cancels it (Figma convention): restore drag-
      // start props on the wire for move/resize/rotate/point; undo an
      // already-submitted create with Delete; drop a marquee/local
      // path outright. No undo entry — a cancel is not a mutation.
      const d = this.drag
      if (d) {
        this.drag = null; this.guides = []; this.marquee = null
        for (const [oid, orig] of d.orig) {
          if (d.mode === 'create') {
            if (d.localCreate) this.session.applyLocal('Delete', { id: oid })
            else this.session.submit('Delete', { id: oid })
          } else {
            // Revert only gesture keys — a remote op may have touched
            // other props mid-drag; restoring them would stomp it.
            const restore: Record<string, unknown> = {}
            for (const k of ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2',
              'rot', 'points'])
              if (orig[k] !== undefined) restore[k] = orig[k]
            this.session.submit('Patch', { id: oid, props: restore })
          }
        }
        this.redraw(); return
      }
      this.selected.clear(); this.redraw(); return
    }
    if (ctrl && (key === 'a' || key === 'A')) {
      // Ctrl+A: every object — standard select-all. Undo-safe (no doc
      // mutation, just selection state).
      for (const o of this.objects()) this.selected.add(o.id)
      this.redraw(); return
    }
    if (ctrl && (key === 'd' || key === 'D')) { this.duplicate(); return }
    if (key === ']') { this.stepReorder(1, ctrl); return }
    if (key === '[') { this.stepReorder(-1, ctrl); return }
    // T-31: font size was hardcoded at create — +/- nudges it on
    // selected text objects. Same Patch+undo pipeline as everything.
    if (key === '=' || key === '-') {
      const dpx = key === '=' ? 2 : -2
      const inv: WireOp[] = [], fwd: WireOp[] = []
      for (const oid of this.selected) {
        const o = this.find(oid)
        if (!o || o.kind !== 'text') continue
        const size = Math.max(6, num(o.props, 'fontSize', 16) + dpx)
        inv.push({ type: 'Patch', payload: { id: oid, props: { fontSize: o.props['fontSize'] ?? null } } })
        fwd.push({ type: 'Patch', payload: { id: oid, props: { fontSize: size } } })
        this.session.submit('Patch', { id: oid, props: { fontSize: size } })
      }
      if (fwd.length) this.recordUndo(inv, fwd)
      return
    }
    // T-27: arrow nudge — 1wu, Shift = 10wu. One Patch per object,
    // one undo entry covering the whole selection.
    const arrow: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    }
    // T-33: align — Alt+arrows snap selection edges to the extreme
    // edge; Alt+h/Alt+v center horizontally/vertically. Box kinds
    // only: line/path have no x/y anchor to align (honest edge).
    // Alignment is by AABB — for rot≠0 the quad's box aligns, which
    // is what a user expects visually.
    if (alt && this.selected.size >= 2) {
      const alignAxis: Record<string, 'x' | 'y'> =
        { ArrowLeft: 'x', ArrowRight: 'x', ArrowUp: 'y', ArrowDown: 'y' }
      const axis = alignAxis[key] ??
        (key === 'h' || key === 'H' ? 'x' : key === 'v' || key === 'V' ? 'y' : null)
      if (axis) {
        const boxes = new Map<string, BBox>()
        for (const oid of this.selected) {
          const o = this.find(oid)
          const b = o && boundsOf(o)
          if (o && b && (o.props['x'] !== undefined)) boxes.set(oid, b)
        }
        if (boxes.size >= 2 && shift && (key === 'H' || key === 'V')) {
          // Distribute: equal gaps, outer pair anchored in place.
          const ord = [...boxes.entries()].sort((a, b) =>
            (axis === 'x' ? a[1].x0 - b[1].x0 : a[1].y0 - b[1].y0))
          const first = ord[0]![1], last = ord[ord.length - 1]![1]
          const lo = axis === 'x' ? first.x0 : first.y0
          const hi = axis === 'x' ? last.x1 : last.y1
          const sizes = ord.map(([, b]) => axis === 'x' ? b.x1 - b.x0 : b.y1 - b.y0)
          const gap = (hi - lo - sizes.reduce((s, v) => s + v, 0)) / (ord.length - 1)
          const inv: WireOp[] = [], fwd: WireOp[] = []
          let pos = lo
          for (const [oid, b] of ord) {
            const cur = axis === 'x' ? b.x0 : b.y0
            const delta = pos - cur
            if (delta !== 0) {
              const o = this.find(oid)!
              const k = axis === 'x' ? 'x' : 'y'
              const props = { [k]: num(o.props, k) + delta }
              inv.push({ type: 'Patch', payload: { id: oid, props: { ...o.props } } })
              fwd.push({ type: 'Patch', payload: { id: oid, props } })
              this.session.submit('Patch', { id: oid, props })
            }
            pos += (axis === 'x' ? b.x1 - b.x0 : b.y1 - b.y0) + gap
          }
          if (fwd.length) this.recordUndo(inv, fwd)
          this.redraw()
          return
        }
        if (boxes.size >= 2) {
          const edge = key === 'ArrowRight' || key === 'ArrowDown'
          const center = key === 'h' || key === 'v'
          let target: number
          if (center) {
            const mids = [...boxes.values()].map((b) =>
              axis === 'x' ? (b.x0 + b.x1) / 2 : (b.y0 + b.y1) / 2)
            target = (Math.min(...mids) + Math.max(...mids)) / 2
          } else {
            target = edge
              ? Math.max(...[...boxes.values()].map((b) => axis === 'x' ? b.x1 : b.y1))
              : Math.min(...[...boxes.values()].map((b) => axis === 'x' ? b.x0 : b.y0))
          }
          const inv: WireOp[] = [], fwd: WireOp[] = []
          for (const [oid, b] of boxes) {
            const cur = center
              ? (axis === 'x' ? (b.x0 + b.x1) / 2 : (b.y0 + b.y1) / 2)
              : edge ? (axis === 'x' ? b.x1 : b.y1) : (axis === 'x' ? b.x0 : b.y0)
            const delta = target - cur
            if (delta === 0) continue
            const o = this.find(oid)!
            const k = axis === 'x' ? 'x' : 'y'
            const props = { [k]: num(o.props, k) + delta }
            inv.push({ type: 'Patch', payload: { id: oid, props: { ...o.props } } })
            fwd.push({ type: 'Patch', payload: { id: oid, props } })
            this.session.submit('Patch', { id: oid, props })
          }
          if (fwd.length) this.recordUndo(inv, fwd)
          this.redraw()
        }
        return
      }
    }
    const a = arrow[key]
    if (a && this.selected.size) {
      const dx = a[0] * (shift ? 10 : 1), dy = a[1] * (shift ? 10 : 1)
      const inv: WireOp[] = [], fwd: WireOp[] = []
      for (const oid of this.selected) {
        const o = this.find(oid)
        if (!o) continue
        const flush: Record<string, unknown> = {}
        for (const k of ['x', 'y', 'x1', 'y1', 'x2', 'y2'])
          if (o.props[k] !== undefined)
            flush[k] = num(o.props, k) + (k[0] === 'x' ? dx : dy)
        if (o.props['points'] !== undefined)
          flush['points'] = (o.props['points'] as { x: number; y: number }[])
            .map((p) => ({ x: p.x + dx, y: p.y + dy }))
        inv.push({ type: 'Patch', payload: { id: oid, props: { ...o.props } } })
        fwd.push({ type: 'Patch', payload: { id: oid, props: flush } })
        this.session.submit('Patch', { id: oid, props: flush })
      }
      if (fwd.length) this.recordUndo(inv, fwd)
      this.redraw()
    }
  }

  /** Ctrl+D: clone each selected object at +20/+20, topmost z. */
  private duplicate(): void {
    const created = new Set<string>()
    const inv: WireOp[] = [], fwd: WireOp[] = []
    for (const oid of this.selected) {
      const o = this.find(oid)
      if (!o) continue
      const nid = this.id()
      const props = { ...o.props }
      if (props['x'] !== undefined) {
        props['x'] = num(props, 'x') + 20
        props['y'] = num(props, 'y') + 20
      } else if (props['points'] !== undefined) {
        props['points'] = (props['points'] as { x: number; y: number }[])
          .map((p) => ({ x: p.x + 20, y: p.y + 20 }))
      } else if (props['x1'] !== undefined) {
        for (const k of ['x1', 'x2']) props[k] = num(props, k) + 20
        for (const k of ['y1', 'y2']) props[k] = num(props, k) + 20
      }
      const cz = this.topZ()
      this.session.submit('Create', { id: nid, kind: o.kind, z: cz, props })
      fwd.push({ type: 'Create', payload: { id: nid, kind: o.kind, z: cz, props } })
      inv.push({ type: 'Delete', payload: { id: nid } })
      created.add(nid)
    }
    if (fwd.length) this.recordUndo(inv, fwd)
    this.selected.clear()
    for (const id of created) this.selected.add(id)
    this.redraw()
  }

  /** ] / [ = front/back; Ctrl+] / Ctrl+[ = one layer step (Figma
   *  convention). Step only for single selection — a multi-object
   *  block would need relative-order preservation (falls back to
   *  front/back, honest edge). */
  private stepReorder(dir: 1 | -1, step: boolean): void {
    const objs = this.objects()
    if (!step || this.selected.size !== 1) { this.reorder(dir); return }
    const i = objs.findIndex((o) => this.selected.has(o.id))
    if (i < 0) return
    const o = objs[i]!
    const up = i + dir
    if (up < 0 || up >= objs.length) return // already at edge
    const beyond = objs[up + dir]
    const z = dir > 0
      ? beyond ? FractionalIndex.between(objs[up]!.z, beyond.z)
               : FractionalIndex.after(objs[up]!.z)
      : beyond ? FractionalIndex.between(beyond.z, objs[up]!.z)
               : FractionalIndex.before(objs[up]!.z)
    this.session.submit('Reorder', { id: o.id, z })
    this.recordUndo(
      [{ type: 'Reorder', payload: { id: o.id, z: o.z } }],
      [{ type: 'Reorder', payload: { id: o.id, z } }])
    this.redraw()
  }

  /** ] = bring to front, [ = send to back — one reorder op each. */
  private reorder(dir: 1 | -1): void {
    if (this.selected.size === 0) return
    const objs = this.objects()
    if (objs.length === 0) return
    const edge = dir > 0 ? objs.at(-1)!.z : objs[0]!.z
    const inv: WireOp[] = [], fwd: WireOp[] = []
    for (const oid of this.selected) {
      const o = this.find(oid)
      if (!o) continue
      const z = dir > 0 ? FractionalIndex.after(edge) : FractionalIndex.before(edge)
      this.session.submit('Reorder', { id: oid, z })
      inv.push({ type: 'Reorder', payload: { id: oid, z: o.z } })
      fwd.push({ type: 'Reorder', payload: { id: oid, z } })
    }
    if (fwd.length) this.recordUndo(inv, fwd)
    this.redraw()
  }

  /** Throttled patch: real submit ≤80ms, local apply otherwise. */
  private patchThrottled(id: string, props: Record<string, unknown>): void {
    const clean: Record<string, unknown> = {}
    for (const k in props) if (props[k] !== undefined) clean[k] = props[k]
    const now = performance.now()
    if (now - this.lastPatch > 80) {
      this.lastPatch = now
      this.session.submit('Patch', { id, props: clean })
    } else {
      this.session.applyLocal('Patch', { id, props: clean })
    }
    this.redraw()
  }
}
