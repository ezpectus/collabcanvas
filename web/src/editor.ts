// Editing tools (T-9, extended T-14): select/move/resize/rotate/
// create/delete + multi-select (marquee & shift-click), duplicate,
// z-order front/back. All mutations go through Session.submit →
// optimistic local apply + server op — one code path, LWW reconciles.
//
// Drag semantics unchanged: local apply per frame (free), wire Patch
// throttled 80ms, final flush on mouseup. Deltas apply to props as of
// mouseDown — no float drift, no mid-drag hijack by foreign patches.

import { boundsOf, computeResize, num, quadOf, type BBox } from './geometry'
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
    if (this.selected.size !== 1) return []
    const o = this.find([...this.selected][0]!)
    if (!o || (o.kind !== 'rect' && o.kind !== 'ellipse'
        && o.kind !== 'text' && o.kind !== 'image')) return []
    const b = boundsOf(o)
    if (!b) return []
    const q = quadOf(b, num(o.props, 'rot'))
    const mid = (a: { x: number; y: number }, c: { x: number; y: number }) =>
      ({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 })
    return [q[0]!, mid(q[0]!, q[1]!), q[1]!, mid(q[1]!, q[2]!),
            q[2]!, mid(q[2]!, q[3]!), q[3]!, mid(q[3]!, q[0]!)]
  }

  mouseDown(wx: number, wy: number, scale = 1, shift = false): void {
    if (this.tool !== 'select') { this.createStart(wx, wy); return }

    const hp = this.handlePoints()
    const tol = 8 / scale
    const hi = hp.findIndex(p => Math.abs(wx - p.x) <= tol && Math.abs(wy - p.y) <= tol)
    if (hi >= 0) {
      const o = this.find([...this.selected][0]!)!
      this.drag = {
        mode: shift && hi === 4 ? 'rotate' : 'resize',
        startX: wx, startY: wy,
        orig: new Map([[o.id, { ...o.props }]]),
        center: shift && hi === 4
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
      this.selected.clear()
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
      const props = { points: [{ x: wx, y: wy }], stroke: '#e8eaf2', lineWidth: 2 }
      this.session.applyLocal('Create', { id, kind: 'path', z, props })
      this.selected.clear(); this.selected.add(id)
      this.drag = { mode: 'create', startX: wx, startY: wy,
                    orig: new Map([[id, props]]), center: null,
                    moved: false, handle: -1, localCreate: { id, z } }
      return
    }
    const props = this.tool === 'line'
      ? { x1: wx, y1: wy, x2: wx, y2: wy, stroke: '#e8eaf2', lineWidth: 2 }
      : { x: wx, y: wy, w: 1, h: 1, rot: 0,
          fill: '#3d5af1', text: this.tool === 'text' ? 'text' : undefined,
          fontSize: 16 }
    this.session.submit('Create', { id, kind: this.tool, z: this.topZ(), props })
    this.selected.clear(); this.selected.add(id)
    this.drag = { mode: 'create', startX: wx, startY: wy,
                  orig: new Map([[id, props]]), center: null, moved: false, handle: -1 }
  }

  mouseMove(wx: number, wy: number, aspect = false): void {
    const d = this.drag
    if (!d) return
    const dx = wx - d.startX
    const dy = wy - d.startY
    d.moved = true

    if (d.mode === 'marquee') {
      this.marquee = { x0: Math.min(d.startX, wx), y0: Math.min(d.startY, wy),
                       x1: Math.max(d.startX, wx), y1: Math.max(d.startY, wy) }
      this.redraw()
      return
    }

    if (d.mode === 'rotate' && d.center) {
      const a0 = Math.atan2(d.startY - d.center.y, d.startX - d.center.x)
      const a1 = Math.atan2(wy - d.center.y, wx - d.center.x)
      const deg = ((a1 - a0) * 180) / Math.PI
      for (const [oid, orig] of d.orig)
        this.patchThrottled(oid, { rot: (num(orig, 'rot') + deg + 360) % 360 })
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
      const props = d.orig.get(d.localCreate.id)!
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
  key(key: string, ctrl = false, shift = false): void {
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
    if (ctrl && (key === 'd' || key === 'D')) { this.duplicate(); return }
    if (key === ']') { this.reorder(1); return }
    if (key === '[') { this.reorder(-1); return }
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
