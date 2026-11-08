// QuadTree over object bboxes (T-9): point hit-test and viewport
// culling in O(visible), not O(all). Entries that straddle quadrant
// boundaries stay in the parent node — the classic tradeoff that
// keeps removal/rebuild trivial.
//
// Rebuild strategy: the index is thrown away and rebuilt when the
// model version changes (cheap at 10k objects, ~ms). No incremental
// updates — a moving object would need remove+insert bookkeeping,
// and rebuild-on-change is provably correct.

import type { CanvasObject, DocModel } from './model'
import { boundsOf, contains, intersects, type BBox } from './geometry'

export class QuadTree {
  private readonly items: { id: string; b: BBox }[] = []
  private kids: QuadTree[] | null = null

  constructor(
    private readonly b: BBox,
    private readonly cap = 8,
    private readonly depth = 0,
    private readonly maxDepth = 10,
  ) {}

  insert(id: string, bb: BBox): void {
    if (this.kids) {
      const k = this.pick(bb)
      if (k) { k.insert(id, bb); return }
    }
    this.items.push({ id, b: bb })
    if (!this.kids && this.items.length > this.cap && this.depth < this.maxDepth)
      this.split()
  }

  query(rect: BBox, out: string[] = []): string[] {
    for (const it of this.items) if (intersects(it.b, rect)) out.push(it.id)
    if (this.kids)
      for (const k of this.kids) if (intersects(k.b, rect)) k.query(rect, out)
    return out
  }

  private pick(bb: BBox): QuadTree | null {
    for (const k of this.kids!)
      if (bb.x0 >= k.b.x0 && bb.x1 <= k.b.x1 && bb.y0 >= k.b.y0 && bb.y1 <= k.b.y1)
        return k
    return null // straddles a boundary — stays at this level
  }

  private split(): void {
    const { x0, y0, x1, y1 } = this.b
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2
    this.kids = [
      new QuadTree({ x0, y0, x1: mx, y1: my }, this.cap, this.depth + 1, this.maxDepth),
      new QuadTree({ x0: mx, y0, x1, y1: my }, this.cap, this.depth + 1, this.maxDepth),
      new QuadTree({ x0, y0: my, x1: mx, y1 }, this.cap, this.depth + 1, this.maxDepth),
      new QuadTree({ x0: mx, y0: my, x1, y1 }, this.cap, this.depth + 1, this.maxDepth),
    ]
    // Re-demote items that now fit a quadrant.
    for (let i = this.items.length - 1; i >= 0; i--) {
      const k = this.pick(this.items[i]!.b)
      if (k) { k.insert(this.items[i]!.id, this.items[i]!.b); this.items.splice(i, 1) }
    }
  }
}

/// Scene index: quadtree + id→object map, rebuilt lazily when
/// DocModel.version advances. Hit-test = query a point-rect, then
/// take the TOPMOST candidate by z (draw order = hit order reversed).
export class SceneIndex {
  private tree: QuadTree | null = null
  private byId = new Map<string, CanvasObject>()
  private builtVersion = -1

  private sync(model: DocModel): void {
    if (model.version === this.builtVersion) return
    const objs = model.objects()
    this.byId = new Map(objs.map((o) => [o.id, o]))

    let bounds: BBox = { x0: -100, y0: -100, x1: 100, y1: 100 }
    for (const o of objs) {
      const b = boundsOf(o)
      if (b) bounds = {
        x0: Math.min(bounds.x0, b.x0), y0: Math.min(bounds.y0, b.y0),
        x1: Math.max(bounds.x1, b.x1), y1: Math.max(bounds.y1, b.y1),
      }
    }
    this.tree = new QuadTree(bounds)
    for (const o of objs) {
      const b = boundsOf(o)
      if (b) this.tree.insert(o.id, b)
    }
    this.builtVersion = model.version
  }

  /** Visible objects in world rect, z-sorted — replaces the renderer's
   * O(n) scan: we pay per drawn object, not per object in the doc. */
  visibleIn(model: DocModel, rect: BBox): CanvasObject[] {
    this.sync(model)
    return this.tree!.query(rect)
      .map((id) => this.byId.get(id)!)
      .sort((a, b) => (a.z === b.z ? (a.id < b.id ? -1 : 1) : a.z < b.z ? -1 : 1))
  }

  /** Topmost object under a world point — z-descending first hit.
   * Honest limit: bbox hit, not true shape containment — clicking the
   * empty corner of an ellipse's box selects it (documented MVP edge). */
  hitTest(model: DocModel, x: number, y: number, pad = 2): CanvasObject | null {
    this.sync(model)
    const rect: BBox = { x0: x - pad, y0: y - pad, x1: x + pad, y1: y + pad }
    const hit = this.tree!.query(rect)
      .map((id) => this.byId.get(id)!)
      .filter((o) => { const b = boundsOf(o); return b && contains(b, x, y) })
      .sort((a, b) => (a.z === b.z ? (a.id < b.id ? 1 : -1) : a.z < b.z ? 1 : -1))
    return hit[0] ?? null
  }
}
