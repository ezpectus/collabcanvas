// Editing tools (T-9): select/move/resize/create/delete over the
// SceneIndex hit-test. All mutations go through Session.submit →
// optimistic local apply + server op — one code path, LWW reconciles.
//
// Drag semantics: local props update IMMEDIATELY via a Patch submit
// throttled to 80ms (remote sees live-ish movement), final patch on
// mouseup. Server may interleave foreign ops — the optimistic seq
// ordering in Session keeps local view consistent, and the echo
// converges.

import { boundsOf, num, type BBox } from './geometry'
import type { CanvasObject } from './model'
import { FractionalIndex } from './fractionalIndex'
import { SceneIndex } from './quadtree'
import type { Session } from './session'

export type Tool = 'select' | 'rect' | 'ellipse' | 'line' | 'text' | 'path'

interface Drag {
  mode: 'move' | 'resize' | 'create' | 'pan-hint'
  startX: number
  startY: number
  /** original props at drag start — deltas apply to these, not to
   * live values, so a long drag doesn't accumulate float error and
   * foreign patches mid-drag don't hijack the gesture */
  orig: Record<string, unknown> | null
  objId: string | null
  moved: boolean
  /** path only: the create lives locally until mouseup submits it */
  localCreate?: { id: string; z: string }
}

export class Editor {
  tool: Tool = 'select'
  selectedId: string | null = null
  private drag: Drag | null = null
  private lastPatch = 0

  constructor(
    private readonly session: Session,
    private readonly index: SceneIndex,
    private readonly redraw: () => void,
  ) {}

  selectionBox(): BBox | null {
    if (!this.selectedId) return null
    const o = this.session.model.objects().find((o) => o.id === this.selectedId)
    return o ? boundsOf(o) : null
  }

  private id(): string {
    return `o-${Math.random().toString(36).slice(2, 10)}`
  }

  private topZ(): string {
    const top = this.session.model.objects().at(-1)?.z
    return top ? FractionalIndex.after(top) : FractionalIndex.first()
  }

  mouseDown(wx: number, wy: number, scale = 1): void {
    if (this.tool === 'select') {
      // Resize handle: bottom-right corner, 8 screen-px in world units.
      const box = this.selectionBox()
      const handle = 8 / scale
      if (box && this.selectedId &&
          wx >= box.x1 - handle && wx <= box.x1 + handle &&
          wy >= box.y1 - handle && wy <= box.y1 + handle) {
        const obj = this.find(this.selectedId)!
        this.drag = { mode: 'resize', startX: wx, startY: wy,
                      orig: { ...obj.props }, objId: obj.id, moved: false }
        return
      }
      const hit = this.index.hitTest(this.session.model, wx, wy)
      this.selectedId = hit?.id ?? null
      this.drag = hit
        ? { mode: 'move', startX: wx, startY: wy,
            orig: { ...hit.props }, objId: hit.id, moved: false }
        : { mode: 'pan-hint', startX: wx, startY: wy,
            orig: null, objId: null, moved: false }
    } else if (this.tool === 'path') {
      // Freehand: LOCAL-ONLY create while drawing — a path is a
      // burst of points, sending it on the wire mid-drag would spam
      // the journal with garbage ops. The real Create (full point
      // list) is submitted once on mouseup; the echo overwrites the
      // temp registers at a real seq.
      const id = this.id()
      const props = { points: [{ x: wx, y: wy }], stroke: '#e8eaf2', lineWidth: 2 }
      const z = this.topZ()
      this.session.applyLocal('Create', { id, kind: 'path', z, props })
      this.selectedId = id
      this.drag = { mode: 'create', startX: wx, startY: wy,
                    orig: props, objId: id, moved: false,
                    localCreate: { id, z } }
    } else {
      // Create tools: drop a provisional object optimistically; the
      // drag shapes it live, mouseup submits the final Create.
      const id = this.id()
      const props = this.tool === 'line'
        ? { x1: wx, y1: wy, x2: wx, y2: wy, stroke: '#e8eaf2', lineWidth: 2 }
        : { x: wx, y: wy, w: 1, h: 1,
            fill: '#3d5af1', text: this.tool === 'text' ? 'text' : undefined,
            fontSize: 16 }
      this.session.submit('Create', { id, kind: this.tool, z: this.topZ(), props })
      this.selectedId = id
      this.drag = { mode: 'create', startX: wx, startY: wy,
                    orig: props, objId: id, moved: false }
    }
    this.redraw()
  }

  mouseMove(wx: number, wy: number): void {
    const d = this.drag
    if (!d || !d.objId || !d.orig) return
    d.moved = true
    const dx = wx - d.startX
    const dy = wy - d.startY

    if (d.mode === 'move') {
      this.patchThrottled(d.objId, {
        x: num(d.orig, 'x') + dx, y: num(d.orig, 'y') + dy,
        x1: d.orig['x1'] !== undefined ? num(d.orig, 'x1') + dx : undefined,
        y1: d.orig['y1'] !== undefined ? num(d.orig, 'y1') + dy : undefined,
        x2: d.orig['x2'] !== undefined ? num(d.orig, 'x2') + dx : undefined,
        y2: d.orig['y2'] !== undefined ? num(d.orig, 'y2') + dy : undefined,
      })
    } else if (d.mode === 'resize') {
      this.patchThrottled(d.objId, {
        w: Math.max(2, num(d.orig, 'w', 1) + dx),
        h: Math.max(2, num(d.orig, 'h', 1) + dy),
      })
    } else if (d.mode === 'create') {
      if (d.localCreate) {
        // Freehand: extend the point list locally (wire is silent
        // until mouseup). Points thinner than ~1.5 world-units are
        // dropped — the list is the op payload, it has a size cost.
        const pts = d.orig['points'] as { x: number; y: number }[]
        const last = pts[pts.length - 1]!
        if ((wx - last.x) ** 2 + (wy - last.y) ** 2 > 2.25) {
          pts.push({ x: wx, y: wy })
          this.session.applyLocal('Patch',
            { id: d.objId, props: { points: pts } })
          this.redraw()
        }
        return
      }
      const props = this.find(d.objId)?.props
      if (props?.['x1'] !== undefined) {
        this.patchThrottled(d.objId, { x2: wx, y2: wy })
      } else {
        this.patchThrottled(d.objId, {
          x: Math.min(d.startX, wx), y: Math.min(d.startY, wy),
          w: Math.abs(dx), h: Math.abs(dy),
        })
      }
    }
  }

  mouseUp(): void {
    const d = this.drag
    this.drag = null
    if (!d) return
    // A create-drag that never moved → degenerate object; delete it
    // rather than leaving a 1px artifact on everyone's screen.
    if (d.mode === 'create' && !d.moved && d.objId) {
      if (d.localCreate)
        this.session.applyLocal('Delete', { id: d.objId }) // never hit the wire
      else
        this.session.submit('Delete', { id: d.objId })
      this.selectedId = null
    } else if (d.localCreate) {
      // The freehand path lands on the wire ONCE, fully formed.
      this.session.submit('Create', {
        id: d.localCreate.id, kind: 'path', z: d.localCreate.z,
        props: d.orig!,
      })
    } else if (d.objId) {
      // The 80ms throttle may have dropped the LAST drag position —
      // flush the object's current props so the wire ends where the
      // mouse did.
      const props = this.find(d.objId)?.props
      if (props) {
        const flush: Record<string, unknown> = {}
        for (const k of ['x', 'y', 'w', 'h', 'x1', 'y1', 'x2', 'y2'])
          if (props[k] !== undefined) flush[k] = props[k]
        this.session.submit('Patch', { id: d.objId, props: flush })
      }
    }
    this.redraw()
  }

  key(key: string): void {
    if ((key === 'Delete' || key === 'Backspace') && this.selectedId) {
      this.session.submit('Delete', { id: this.selectedId })
      this.selectedId = null
      this.redraw()
    }
  }

  private find(id: string): CanvasObject | undefined {
    return this.session.model.objects().find((o) => o.id === id)
  }

  /** Throttled patch: local optimistic apply every call (instant
   * feedback), real submit at most every 80ms + always mark dirty.
   * Undefined values are dropped — patch writes only real props. */
  private patchThrottled(id: string, props: Record<string, unknown>): void {
    const clean: Record<string, unknown> = {}
    for (const k in props) if (props[k] !== undefined) clean[k] = props[k]
    const now = performance.now()
    if (now - this.lastPatch > 80) {
      this.lastPatch = now
      this.session.submit('Patch', { id, props: clean })
    } else {
      // Between submits: apply locally without spending a clientSeq —
      // direct model write via a synthetic patch keeps feedback instant.
      // It rides on a fractional seq inside session.submit normally, so
      // here we just reuse submit's path minus the wire: cheap trick —
      // submit anyway but rely on server dedup? No: emit a LOCAL apply
      // through session's optimistic path with zero wire cost.
      this.session.applyLocal('Patch', { id, props: clean })
    }
    this.redraw()
  }
}
