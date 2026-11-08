// Canvas 2D renderer (T-8): world→screen viewport transform, bbox
// culling, per-kind draw, and a rAF loop gated by a dirty flag — the
// frame budget is spent ONLY when state or viewport actually changed.
// React owns nothing here: this class owns the canvas and the loop;
// React only mounts it and reads stats.

import type { CanvasObject } from './model'
import type { PresenceUpdate } from './protocol'

export interface Viewport { x: number; y: number; scale: number }

export interface FrameStats {
  objects: number
  drawn: number   // after culling
  drawMs: number  // EMA of draw call duration
  fps: number     // EMA while frames actually render
}

const num = (p: Record<string, unknown>, k: string, d = 0): number =>
  typeof p[k] === 'number' ? (p[k] as number) : d
const str = (p: Record<string, unknown>, k: string, d = ''): string =>
  typeof p[k] === 'string' ? (p[k] as string) : d

interface BBox { x0: number; y0: number; x1: number; y1: number }

function boundsOf(o: CanvasObject): BBox | null {
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

export class Renderer {
  readonly view: Viewport = { x: 80, y: 60, scale: 1 }
  private dirty = true
  private raf = 0
  private ro: ResizeObserver | null = null
  private stats: FrameStats = { objects: 0, drawn: 0, drawMs: 0, fps: 0 }
  private lastFrame = 0
  onFrame: ((s: FrameStats) => void) | null = null

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly getObjects: () => CanvasObject[],
    private readonly getCursors: () => Iterable<PresenceUpdate>,
  ) {}

  markDirty(): void { this.dirty = true }

  start(): void {
    // Track the parent box, not window: canvas fills a flex cell.
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(this.canvas.parentElement!)
    this.resize()

    const tick = (t: number) => {
      if (this.dirty) {
        this.dirty = false
        const dpr = window.devicePixelRatio || 1
        const t0 = performance.now()
        this.draw(dpr)
        const dt = performance.now() - t0
        const s = this.stats
        s.drawMs = s.drawMs * 0.9 + dt * 0.1
        if (this.lastFrame) {
          const fps = 1000 / Math.max(1, t - this.lastFrame)
          s.fps = s.fps * 0.9 + fps * 0.1
        }
        this.lastFrame = t
        this.onFrame?.(s)
      }
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
    this.ro?.disconnect()
  }

  /** CSS-pixel point → world coordinates (for hit-tests/cursors). */
  toWorld(cx: number, cy: number): { x: number; y: number } {
    const v = this.view
    return { x: (cx - v.x) / v.scale, y: (cy - v.y) / v.scale }
  }

  pan(dxCss: number, dyCss: number): void {
    this.view.x += dxCss
    this.view.y += dyCss
    this.markDirty()
  }

  /** Zoom keeping the cursor's world point fixed on screen. */
  zoomAt(cx: number, cy: number, factor: number): void {
    const v = this.view
    const s2 = Math.min(8, Math.max(0.1, v.scale * factor))
    v.x = cx - ((cx - v.x) / v.scale) * s2
    v.y = cy - ((cy - v.y) / v.scale) * s2
    v.scale = s2
    this.markDirty()
  }

  private resize(): void {
    const parent = this.canvas.parentElement!
    const dpr = window.devicePixelRatio || 1
    this.canvas.width = Math.max(1, parent.clientWidth * dpr)
    this.canvas.height = Math.max(1, parent.clientHeight * dpr)
    this.canvas.style.width = `${parent.clientWidth}px`
    this.canvas.style.height = `${parent.clientHeight}px`
    this.markDirty()
  }

  private draw(dpr: number): void {
    const ctx = this.canvas.getContext('2d')!
    const v = this.view
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.x, dpr * v.y)

    // World-space visible rect for culling (pad for line widths).
    const w = this.canvas.width / dpr
    const h = this.canvas.height / dpr
    const view: BBox = {
      x0: -v.x / v.scale - 8, y0: -v.y / v.scale - 8,
      x1: (w - v.x) / v.scale + 8, y1: (h - v.y) / v.scale + 8,
    }

    const objects = this.getObjects()
    let drawn = 0
    for (const o of objects) {
      const b = boundsOf(o)
      if (!b || b.x1 < view.x0 || b.x0 > view.x1 || b.y1 < view.y0 || b.y0 > view.y1)
        continue // culled — the whole point of bounding boxes
      drawn++
      drawObject(ctx, o)
    }

    // Remote cursors on top — world-space dots + client label.
    for (const u of this.getCursors()) {
      const c = u.cursor as { x?: number; y?: number }
      if (typeof c?.x !== 'number' || typeof c.y !== 'number') continue
      ctx.beginPath()
      ctx.arc(c.x, c.y, 5 / v.scale, 0, Math.PI * 2)
      ctx.fillStyle = u.color
      ctx.fill()
      ctx.font = `${12 / v.scale}px sans-serif`
      ctx.fillText(u.clientId, c.x + 8 / v.scale, c.y - 4 / v.scale)
    }

    this.stats.objects = objects.length
    this.stats.drawn = drawn
  }
}

function drawObject(ctx: CanvasRenderingContext2D, o: CanvasObject): void {
  const p = o.props
  const fill = str(p, 'fill', '#8892b0')
  const stroke = str(p, 'stroke', '')
  switch (o.kind) {
    case 'rect':
      ctx.fillStyle = fill
      ctx.fillRect(num(p, 'x'), num(p, 'y'), num(p, 'w', 10), num(p, 'h', 10))
      if (stroke) { ctx.strokeStyle = stroke; ctx.strokeRect(num(p, 'x'), num(p, 'y'), num(p, 'w', 10), num(p, 'h', 10)) }
      break
    case 'ellipse': {
      const x = num(p, 'x'), y = num(p, 'y'), w = num(p, 'w', 10), h = num(p, 'h', 10)
      ctx.beginPath()
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
      ctx.fillStyle = fill
      ctx.fill()
      if (stroke) { ctx.strokeStyle = stroke; ctx.stroke() }
      break
    }
    case 'line':
      ctx.beginPath()
      ctx.moveTo(num(p, 'x1'), num(p, 'y1'))
      ctx.lineTo(num(p, 'x2'), num(p, 'y2'))
      ctx.strokeStyle = stroke || fill
      ctx.lineWidth = num(p, 'lineWidth', 2)
      ctx.stroke()
      break
    case 'text':
      ctx.fillStyle = fill
      ctx.font = `${num(p, 'fontSize', 16)}px sans-serif`
      ctx.fillText(str(p, 'text', '…'), num(p, 'x'), num(p, 'y'))
      break
    case 'path': {
      const pts = p['points'] as { x: number; y: number }[] | undefined
      if (!pts?.length) break
      ctx.beginPath()
      ctx.moveTo(pts[0]!.x, pts[0]!.y)
      for (const pt of pts) ctx.lineTo(pt.x, pt.y)
      ctx.strokeStyle = stroke || fill
      ctx.lineWidth = num(p, 'lineWidth', 2)
      ctx.stroke()
      break
    }
    case 'image': {
      // URL stub (T-1): draw a framed placeholder — real loading is
      // stretch; an <img> cache here would be the first leak candidate.
      const x = num(p, 'x'), y = num(p, 'y'), w = num(p, 'w', 80), h = num(p, 'h', 60)
      ctx.fillStyle = '#2a2a38'
      ctx.fillRect(x, y, w, h)
      ctx.strokeStyle = '#3a3f55'
      ctx.strokeRect(x, y, w, h)
      ctx.fillStyle = '#777f96'
      ctx.font = '10px sans-serif'
      ctx.fillText('img', x + 4, y + 12)
      break
    }
  }
}
