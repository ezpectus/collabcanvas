// Canvas 2D renderer (T-8): world→screen viewport transform, bbox
// culling, per-kind draw, and a rAF loop gated by a dirty flag — the
// frame budget is spent ONLY when state or viewport actually changed.
// React owns nothing here: this class owns the canvas and the loop;
// React only mounts it and reads stats.

import type { CanvasObject, DocModel } from './model'
import type { PresenceUpdate } from './protocol'
import { num, quadOf, str, boundsOf, type BBox } from './geometry'
import type { SceneIndex } from './quadtree'

export interface Viewport { x: number; y: number; scale: number }

export interface FrameStats {
  objects: number
  drawn: number   // after culling
  drawMs: number  // EMA of draw call duration
  fps: number     // EMA while frames actually render
}

export class Renderer {
  /** T-23: grid visible while snap mode is on. */
  showGrid = false
  /** T-25: minimap overlay, toggled with `m`. */
  showMinimap = false
  readonly view: Viewport = { x: 80, y: 60, scale: 1 }
  /** T-36: blobId → authenticated URL (set by App via session). */
  blobUrl: ((id: string) => string) | null = null
  /** blobId → image | 'err' (absent = still loading, kicked once). */
  private readonly imgCache = new Map<string, HTMLImageElement | 'err'>()
  private dirty = true
  private raf = 0
  private ro: ResizeObserver | null = null
  private stats: FrameStats = { objects: 0, drawn: 0, drawMs: 0, fps: 0 }
  private lastFrame = 0
  onFrame: ((s: FrameStats) => void) | null = null

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly model: DocModel,
    private readonly index: SceneIndex,
    private readonly getCursors: () => Iterable<PresenceUpdate>,
    private readonly getSelection: () => { x: number; y: number }[][],
    private readonly getMarquee: () => BBox | null,
    private readonly getHandles: () => { x: number; y: number }[] = () => [],
    private readonly getGuides: () => { axis: 'v' | 'h'; pos: number }[] = () => [],
  ) {}

  markDirty(): void { this.dirty = true }

  /** T-36: cached blob image — returns the element once loaded,
      'err' on failure, null while still fetching (kick once). */
  private imgFor(src: string): HTMLImageElement | 'err' | null {
    const hit = this.imgCache.get(src)
    if (hit !== undefined) return hit === 'err' ? 'err' : hit.complete && hit.naturalWidth ? hit : null
    if (!this.blobUrl) return 'err'
    const el = new Image()
    el.onload = () => this.markDirty()
    el.onerror = () => { this.imgCache.set(src, 'err'); this.markDirty() }
    el.src = this.blobUrl(src)
    this.imgCache.set(src, el)
    return null
  }

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

    // T-23: grid — only while snapping is on; drawn under objects.
    // Density adapts: below ~8 screen px per cell lines merge to noise,
    // so the step doubles until it breathes.
    if (this.showGrid) {
      let step = 10
      while (step * v.scale < 8) step *= 2
      ctx.lineWidth = 1 / v.scale
      ctx.strokeStyle = 'rgba(95,141,255,0.12)'
      ctx.beginPath()
      for (let x = Math.floor(view.x0 / step) * step; x <= view.x1; x += step) {
        ctx.moveTo(x, view.y0); ctx.lineTo(x, view.y1)
      }
      for (let y = Math.floor(view.y0 / step) * step; y <= view.y1; y += step) {
        ctx.moveTo(view.x0, y); ctx.lineTo(view.x1, y)
      }
      ctx.stroke()
    }

    // Quadtree culling: pay per drawn object, not per object in doc.
    const objects = this.index.visibleIn(this.model, view)
    for (const o of objects) drawObject(ctx, o, (s) => this.imgFor(s))
    const drawn = objects.length

    for (const quad of this.getSelection()) this.drawSelection(ctx, quad)
    const mq = this.getMarquee()
    if (mq) {
      ctx.strokeStyle = '#5f8dff'
      ctx.lineWidth = 1 / v.scale
      ctx.setLineDash([4 / v.scale, 4 / v.scale])
      ctx.strokeRect(mq.x0, mq.y0, mq.x1 - mq.x0, mq.y1 - mq.y0)
      ctx.setLineDash([])
    }

    // T-30: alignment guide lines — full-viewport hairlines at the
    // snapped edge while the drag is in progress.
    const guides = this.getGuides()
    if (guides.length) {
      ctx.strokeStyle = '#ff5fa2'
      ctx.lineWidth = 1 / v.scale
      ctx.beginPath()
      for (const g of guides) {
        if (g.axis === 'v') { ctx.moveTo(g.pos, view.y0); ctx.lineTo(g.pos, view.y1) }
        else { ctx.moveTo(view.x0, g.pos); ctx.lineTo(view.x1, g.pos) }
      }
      ctx.stroke()
    }

    // Remote cursors + their selection frames (T-18): each user's
    // selected objects get a dashed quad in THAT user's color.
    let idMap: Map<string, CanvasObject> | null = null
    for (const u of this.getCursors()) {
      if (u.selection?.length) {
        if (!idMap) {
          idMap = new Map()
          for (const o of this.model.objects()) idMap.set(o.id, o)
        }
        ctx.strokeStyle = u.color
        ctx.lineWidth = 1.5 / v.scale
        ctx.setLineDash([5 / v.scale, 3 / v.scale])
        for (const oid of u.selection) {
          const o = idMap.get(oid)
          const b = o && boundsOf(o)
          if (!b) continue // stale selection on a deleted object — skip
          const q = quadOf(b, num(o!.props, 'rot'))
          ctx.beginPath()
          ctx.moveTo(q[0]!.x, q[0]!.y)
          for (const pt of q.slice(1)) ctx.lineTo(pt.x, pt.y)
          ctx.closePath()
          ctx.stroke()
        }
        ctx.setLineDash([])
      }
      const c = u.cursor as { x?: number; y?: number }
      if (typeof c?.x !== 'number' || typeof c.y !== 'number') continue
      ctx.beginPath()
      ctx.arc(c.x, c.y, 5 / v.scale, 0, Math.PI * 2)
      ctx.fillStyle = u.color
      ctx.fill()
      ctx.font = `${12 / v.scale}px sans-serif`
      ctx.fillText(u.name ?? u.clientId, c.x + 8 / v.scale, c.y - 4 / v.scale)
    }

    // T-25: minimap — screen-space overlay (separate transform).
    // Toggled with `m`; off by default since every object is a dot.
    if (this.showMinimap) this.drawMinimap(ctx, dpr, view)

    this.stats.objects = this.model.objectCount()
    this.stats.drawn = drawn
  }

  /** Whole-doc bounds cached per model version — minimap + any
   *  future "where am I" needs it; 10k-object scans aren't free. */
  private docBounds: BBox | null = null
  private docBoundsVer = -1
  private getDocBounds(): BBox | null {
    if (this.docBoundsVer === this.model.version) return this.docBounds
    let b: BBox | null = null
    for (const o of this.model.objects()) {
      const ob = boundsOf(o)
      if (!ob) continue
      b = b
        ? { x0: Math.min(b.x0, ob.x0), y0: Math.min(b.y0, ob.y0),
            x1: Math.max(b.x1, ob.x1), y1: Math.max(b.y1, ob.y1) }
        : ob
    }
    this.docBounds = b
    this.docBoundsVer = this.model.version
    return b
  }

  private drawMinimap(ctx: CanvasRenderingContext2D, dpr: number,
    view: BBox): void {
    const db = this.getDocBounds()
    if (!db) return
    const MW = 170, MH = 110, PAD = 10
    const cw = this.canvas.width, ch = this.canvas.height
    const mx = cw - (MW + PAD) * dpr, my = ch - (MH + PAD) * dpr
    const bw = Math.max(1, db.x1 - db.x0), bh = Math.max(1, db.y1 - db.y0)
    const s = Math.min(MW / bw, MH / bh) * 0.9
    const ox = mx + ((MW - bw * s) / 2) * dpr, oy = my + ((MH - bh * s) / 2) * dpr
    const px = (x: number) => ox + (x - db.x0) * s * dpr
    const py = (y: number) => oy + (y - db.y0) * s * dpr

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = 'rgba(16,22,36,0.85)'
    ctx.strokeStyle = '#3a4a6b'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(mx, my, MW * dpr, MH * dpr, 6 * dpr)
    ctx.fill(); ctx.stroke()

    // Object dots — cheap fillRect each; at 10k this is ~1-2ms.
    ctx.fillStyle = 'rgba(95,141,255,0.7)'
    const d = Math.max(1.5, 2 * dpr)
    for (const o of this.model.objects()) {
      const ob = boundsOf(o)
      if (ob) ctx.fillRect(px((ob.x0 + ob.x1) / 2) - d / 2,
        py((ob.y0 + ob.y1) / 2) - d / 2, d, d)
    }
    // Viewport rect in world→map coords — lineWidth is global state;
    // without a reset it would inherit the last object's stroke width.
    ctx.strokeStyle = '#e8eaf2'
    ctx.lineWidth = 1
    ctx.strokeRect(px(view.x0), py(view.y0),
      (view.x1 - view.x0) * s * dpr, (view.y1 - view.y0) * s * dpr)
  }

  /** Zoom so the whole world-bounds fits with padding (hotkey `1`). */
  fitBounds(b: BBox): void {
    const parent = this.canvas.parentElement!
    const w = parent.clientWidth, h = parent.clientHeight
    const bw = Math.max(1, b.x1 - b.x0), bh = Math.max(1, b.y1 - b.y0)
    this.view.scale = Math.min(8, Math.max(0.1,
      Math.min(w / bw, h / bh) * 0.9))
    this.view.x = w / 2 - ((b.x0 + b.x1) / 2) * this.view.scale
    this.view.y = h / 2 - ((b.y0 + b.y1) / 2) * this.view.scale
    this.markDirty()
  }

  /** Dashed selection outline (rotated quad) + BR resize handle. */
  private drawSelection(ctx: CanvasRenderingContext2D,
    quad: { x: number; y: number }[]): void {
    const v = this.view
    ctx.strokeStyle = '#5f8dff'
    ctx.lineWidth = 1.5 / v.scale
    ctx.setLineDash([6 / v.scale, 4 / v.scale])
    ctx.beginPath()
    ctx.moveTo(quad[0]!.x, quad[0]!.y)
    for (const pt of quad.slice(1)) ctx.lineTo(pt.x, pt.y)
    ctx.closePath()
    ctx.stroke()
    ctx.setLineDash([])
    // T-16: all 8 handles on a single box-kind selection.
    const h = 8 / v.scale
    ctx.fillStyle = '#5f8dff'
    for (const p of this.getHandles())
      ctx.fillRect(p.x - h / 2, p.y - h / 2, h, h)
  }
}

function drawObject(ctx: CanvasRenderingContext2D, o: CanvasObject,
  imgFor: (src: string) => HTMLImageElement | 'err' | null = () => 'err'): void {
  const p = o.props
  // T-39: per-object opacity — plain prop, LWW-merged for free.
  const alpha = num(p, 'opacity', 1)
  if (alpha !== 1) ctx.globalAlpha = alpha
  const fill = str(p, 'fill', '#8892b0')
  const stroke = str(p, 'stroke', '')
  const rot = num(p, 'rot')
  if (rot) { // rotate around the object's own center
    const cx = num(p, 'x') + num(p, 'w', 10) / 2
    const cy = num(p, 'y') + num(p, 'h', 10) / 2
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate((rot * Math.PI) / 180)
    ctx.translate(-cx, -cy)
  }
  switch (o.kind) {
    case 'rect': {
      const rx = num(p, 'x'), ry = num(p, 'y'),
        rw = num(p, 'w', 10), rh = num(p, 'h', 10)
      const rad = Math.max(0, Math.min(num(p, 'radius'),
        Math.min(rw, rh) / 2))
      if (rad) {
        ctx.beginPath()
        ctx.roundRect(rx, ry, rw, rh, rad)
        if (fill !== 'none') { ctx.fillStyle = fill; ctx.fill() }
        if (stroke && stroke !== 'none') {
          ctx.strokeStyle = stroke
          ctx.lineWidth = num(p, 'lineWidth', 1)
          ctx.stroke()
        }
      } else {
        if (fill !== 'none') {
          ctx.fillStyle = fill
          ctx.fillRect(rx, ry, rw, rh)
        }
        if (stroke && stroke !== 'none') {
          ctx.strokeStyle = stroke
          ctx.lineWidth = num(p, 'lineWidth', 1)
          ctx.strokeRect(rx, ry, rw, rh)
        }
      }
      break
    }
    case 'ellipse': {
      const x = num(p, 'x'), y = num(p, 'y'), w = num(p, 'w', 10), h = num(p, 'h', 10)
      ctx.beginPath()
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
      if (fill !== 'none') { ctx.fillStyle = fill; ctx.fill() }
      if (stroke && stroke !== 'none') {
        ctx.strokeStyle = stroke
        ctx.lineWidth = num(p, 'lineWidth', 1)
        ctx.stroke()
      }
      break
    }
    case 'line':
      ctx.beginPath()
      ctx.moveTo(num(p, 'x1'), num(p, 'y1'))
      ctx.lineTo(num(p, 'x2'), num(p, 'y2'))
      ctx.strokeStyle = stroke && stroke !== 'none' ? stroke : fill
      ctx.lineWidth = num(p, 'lineWidth', 2)
      const dl = str(p, 'dash')
      if (dl === 'dashed') ctx.setLineDash([8, 5])
      else if (dl === 'dotted') ctx.setLineDash([2, 4])
      ctx.stroke()
      ctx.setLineDash([])
      break
    case 'text': {
      if (fill === 'none') break
      ctx.fillStyle = fill
      ctx.font = `${num(p, 'fontSize', 16)}px sans-serif`
      // align: anchor inside the w-box (Figma-style). Canvas default
      // is 'left' — center/right move the fillText anchor.
      const al = str(p, 'align')
      if (al === 'center' || al === 'right') {
        ctx.textAlign = al
        ctx.fillText(str(p, 'text', '…'),
          num(p, 'x') + (al === 'center' ? num(p, 'w', 10) / 2
                                         : num(p, 'w', 10)),
          num(p, 'y'))
        ctx.textAlign = 'left'
      } else
        ctx.fillText(str(p, 'text', '…'), num(p, 'x'), num(p, 'y'))
      break
    }
    case 'path': {
      const pts = p['points'] as { x: number; y: number }[] | undefined
      if (!pts?.length) break
      ctx.beginPath()
      ctx.moveTo(pts[0]!.x, pts[0]!.y)
      for (const pt of pts) ctx.lineTo(pt.x, pt.y)
      ctx.strokeStyle = stroke && stroke !== 'none' ? stroke : fill
      ctx.lineWidth = num(p, 'lineWidth', 2)
      const dp = str(p, 'dash')
      if (dp === 'dashed') ctx.setLineDash([8, 5])
      else if (dp === 'dotted') ctx.setLineDash([2, 4])
      ctx.stroke()
      ctx.setLineDash([])
      break
    }
    case 'image': {
      const x = num(p, 'x'), y = num(p, 'y'), w = num(p, 'w', 80), h = num(p, 'h', 60)
      // T-36: props.src = blobId → async img load, placeholder until
      // it lands. Cache survives frames; 'err' keeps the frame cheap.
      const src = typeof p['src'] === 'string' ? p['src'] as string : null
      const img = src ? imgFor(src) : 'err'
      if (img instanceof HTMLImageElement) {
        ctx.drawImage(img, x, y, w, h)
      } else {
        ctx.fillStyle = '#2a2a38'
        ctx.fillRect(x, y, w, h)
        ctx.strokeStyle = '#3a3f55'
        ctx.strokeRect(x, y, w, h)
        ctx.fillStyle = '#777f96'
        ctx.font = '10px sans-serif'
        ctx.fillText(img === 'err' ? 'img ✕' : 'img…', x + 4, y + 12)
      }
      break
    }
  }
  if (rot) ctx.restore()
  if (alpha !== 1) ctx.globalAlpha = 1
}
