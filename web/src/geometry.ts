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
  switch (o.kind) {
    case 'rect': case 'ellipse': case 'text': case 'image': {
      const x = num(p, 'x'), y = num(p, 'y')
      return { x0: x, y0: y, x1: x + num(p, 'w', 10), y1: y + num(p, 'h', 10) }
    }
    case 'line': {
      const x0 = num(p, 'x1'), y0 = num(p, 'y1')
      const x1 = num(p, 'x2'), y1 = num(p, 'y2')
      return { x0: Math.min(x0, x1), y0: Math.min(y0, y1),
               x1: Math.max(x0, x1), y1: Math.max(y0, y1) }
    }
    case 'path': {
      const pts = p['points'] as { x: number; y: number }[] | undefined
      if (!pts?.length) return null
      let b: BBox = { x0: pts[0]!.x, y0: pts[0]!.y, x1: pts[0]!.x, y1: pts[0]!.y }
      for (const pt of pts) {
        b = { x0: Math.min(b.x0, pt.x), y0: Math.min(b.y0, pt.y),
              x1: Math.max(b.x1, pt.x), y1: Math.max(b.y1, pt.y) }
      }
      return b
    }
    default: return null
  }
}

export const intersects = (a: BBox, b: BBox): boolean =>
  !(a.x1 < b.x0 || a.x0 > b.x1 || a.y1 < b.y0 || a.y0 > b.y1)

export const contains = (b: BBox, x: number, y: number): boolean =>
  x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1
