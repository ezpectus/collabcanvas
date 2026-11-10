// Shared geometry: bounding boxes for all object kinds. Used by the
// renderer (culling), the SceneIndex (quadtree), and the editor
// (hit-test/selection handles).

import type { CanvasObject } from './model'

export interface BBox { x0: number; y0: number; x1: number; y1: number }

export const num = (p: Record<string, unknown>, k: string, d = 0): number =>
  typeof p[k] === 'number' ? (p[k] as number) : d
export const str = (p: Record<string, unknown>, k: string, d = ''): string =>
  typeof p[k] === 'string' ? (p[k] as string) : d

export function boundsOf(o: CanvasObject): BBox | null {
  const p = o.props
  let b: BBox | null
  switch (o.kind) {
    case 'rect': case 'ellipse': case 'text': case 'image': {
      const x = num(p, 'x'), y = num(p, 'y')
      b = { x0: x, y0: y, x1: x + num(p, 'w', 10), y1: y + num(p, 'h', 10) }
      break
    }
    case 'line': {
      const x0 = num(p, 'x1'), y0 = num(p, 'y1')
      const x1 = num(p, 'x2'), y1 = num(p, 'y2')
      b = { x0: Math.min(x0, x1), y0: Math.min(y0, y1),
            x1: Math.max(x0, x1), y1: Math.max(y0, y1) }
      break
    }
    case 'path': {
      const pts = p['points'] as { x: number; y: number }[] | undefined
      if (!pts?.length) return null
      b = { x0: pts[0]!.x, y0: pts[0]!.y, x1: pts[0]!.x, y1: pts[0]!.y }
      for (const pt of pts) {
        b = { x0: Math.min(b.x0, pt.x), y0: Math.min(b.y0, pt.y),
              x1: Math.max(b.x1, pt.x), y1: Math.max(b.y1, pt.y) }
      }
      break
    }
    default: return null
  }
  return rotatedBounds(b, num(p, 'rot'))
}

/** AABB → AABB of the ROTATED quad (rot degrees around center).
 * Culling/hit-test work on this — slightly generous for thin shapes,
 * never wrong. */
export function rotatedBounds(b: BBox, rotDeg: number): BBox {
  if (!rotDeg) return b
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2
  const r = (rotDeg * Math.PI) / 180
  const c = Math.cos(r), s = Math.sin(r)
  let out: BBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]) {
    const rx = cx + (x! - cx) * c - (y! - cy) * s
    const ry = cy + (x! - cx) * s + (y! - cy) * c
    out = { x0: Math.min(out.x0, rx), y0: Math.min(out.y0, ry),
            x1: Math.max(out.x1, rx), y1: Math.max(out.y1, ry) }
  }
  return out
}

/** T-16: resize math, pure and testable. World delta (dx,dy) → new
 * box props. The grabbed handle's direction [sx,sy] grows/shrinks
 * each local axis; the OPPOSITE edge stays pixel-fixed in world. */
export function computeResize(
  props: Record<string, unknown>,
  handle: number, // index into [TL,T,TR,R,BR,B,BL,L] — [sx,sy] pairs
  dx: number, dy: number, // world-space drag delta
  aspect = false,
): { x: number; y: number; w: number; h: number } {
  const DIRS: [number, number][] = [
    [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]]
  const rot = (num(props, 'rot') * Math.PI) / 180
  const c0 = Math.cos(-rot), s0 = Math.sin(-rot)
  const dxl = dx * c0 - dy * s0 // world delta → object's local axes
  const dyl = dx * s0 + dy * c0
  const [sx, sy] = DIRS[handle] ?? [1, 1]
  const w0 = num(props, 'w', 1), h0 = num(props, 'h', 1)
  let w2 = Math.max(2, w0 + sx * dxl)
  let h2 = Math.max(2, h0 + sy * dyl)
  if (aspect && (sx !== 0 || sy !== 0)) {
    const ratio = w0 / h0
    if (sy === 0 || Math.abs(w2 / w0 - 1) >= Math.abs(h2 / h0 - 1)) h2 = w2 / ratio
    else w2 = h2 * ratio
  }
  // Anchor shift: the opposite edge's center-offset scales with w/h;
  // move the center by the rotated difference so it stays fixed.
  const dax = (-sx) * (w0 - w2) / 2
  const day = (-sy) * (h0 - h2) / 2
  const cr = Math.cos(rot), sr = Math.sin(rot)
  const cx0 = num(props, 'x') + w0 / 2, cy0 = num(props, 'y') + h0 / 2
  return {
    x: cx0 + dax * cr - day * sr - w2 / 2,
    y: cy0 + dax * sr + day * cr - h2 / 2,
    w: w2, h: h2,
  }
}

/** AABB → rotated quad corners [TL,TR,BR,BL] in world coords. */
export function quadOf(b: BBox, rotDeg: number): { x: number; y: number }[] {
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2
  const r = (rotDeg * Math.PI) / 180
  const c = Math.cos(r), s = Math.sin(r)
  return [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]]
    .map(([x, y]) => ({
      x: cx + (x! - cx) * c - (y! - cy) * s,
      y: cy + (x! - cx) * s + (y! - cy) * c,
    }))
}

/** T-21: Ramer–Douglas–Peucker polyline simplification. Drops
 *  points within `eps` of the chord — a freehand stroke keeps its
 *  shape at a fraction of the payload (long paths were the biggest
 *  op bodies on the wire). First/last points always survive. */
export function simplifyPoints(
  pts: { x: number; y: number }[], eps: number,
): { x: number; y: number }[] {
  if (pts.length <= 2) return pts
  const a = pts[0]!, b = pts[pts.length - 1]!
  let maxD = 0, maxI = 0
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!
    // Perpendicular distance (projected fallback for degenerate chords).
    const d = len2 === 0
      ? Math.hypot(p.x - a.x, p.y - a.y)
      : Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / Math.sqrt(len2)
    if (d > maxD) { maxD = d; maxI = i }
  }
  if (maxD <= eps) return [a, b]
  return [
    ...simplifyPoints(pts.slice(0, maxI + 1), eps).slice(0, -1),
    ...simplifyPoints(pts.slice(maxI), eps),
  ]
}

export const intersects = (a: BBox, b: BBox): boolean =>
  !(a.x1 < b.x0 || a.x0 > b.x1 || a.y1 < b.y0 || a.y0 > b.y1)

/** T-29: precise hit for open shapes. AABB says "inside" for a
 *  diagonal line's whole bounding box — clicking its empty corner
 *  steals the click from objects below. Point-to-segment distance
 *  is the real test: within `tol` of ANY segment = hit. */
export function hitsStroke(o: CanvasObject, x: number, y: number,
  tol: number): boolean {
  const p = o.props
  const segs: [number, number, number, number][] = []
  if (o.kind === 'line') {
    segs.push([num(p, 'x1'), num(p, 'y1'), num(p, 'x2'), num(p, 'y2')])
  } else if (o.kind === 'path') {
    const pts = (p['points'] as { x: number; y: number }[] | undefined) ?? []
    for (let i = 1; i < pts.length; i++)
      segs.push([pts[i - 1]!.x, pts[i - 1]!.y, pts[i]!.x, pts[i]!.y])
  } else return false
  const lw = num(p, 'lineWidth', 2) / 2
  const t2 = (tol + lw) * (tol + lw)
  return segs.some(([ax, ay, bx, by]) => {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy
    const u = l2 === 0 ? 0 : Math.max(0, Math.min(1,
      ((x - ax) * dx + (y - ay) * dy) / l2))
    const px = ax + u * dx - x, py = ay + u * dy - y
    return px * px + py * py <= t2
  })
}

export const contains = (b: BBox, x: number, y: number): boolean =>
  x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1
