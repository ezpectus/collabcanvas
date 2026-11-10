// Unit check for T-16 resize math — runs the COMPILED geometry.ts,
// not a copy: `npx tsc src/geometry.ts --outDir .test-build` first.
// Verifies: opposite edge stays fixed, rotated objects resize along
// their own axes, aspect lock keeps ratio, min-size clamp holds.
import assert from 'node:assert'
import { computeResize } from './.test-build/geometry.js'

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps
let fails = 0
const ok = (n, c) => { console.log(`${c ? ' ok ' : 'FAIL'}  ${n}`); if (!c) fails++ }

const box = { x: 100, y: 50, w: 200, h: 100, rot: 0 }

// BR handle (4): +30/+20 world → w/h grow, TL corner pinned.
{
  const r = computeResize(box, 4, 30, 20)
  ok('BR: grows w/h', near(r.w, 230) && near(r.h, 120))
  ok('BR: TL corner pinned', near(r.x, 100) && near(r.y, 50))
}
// TL handle (0): drag +30/+20 → box shrinks from TL, BR pinned at (300,150).
{
  const r = computeResize(box, 0, 30, 20)
  ok('TL: shrinks w/h', near(r.w, 170) && near(r.h, 80))
  ok('TL: BR pinned', near(r.x + r.w, 300) && near(r.y + r.h, 150))
}
// R edge (3): only w changes, vertical center pinned.
{
  const r = computeResize(box, 3, 40, 999)
  ok('R: w only', near(r.w, 240) && near(r.h, 100) && near(r.y, 50))
}
// Rotated 90°: a +x world drag is the object's local -y → dragging R
// (which in object space is +x_local... at rot=90 local x maps to
// world -y) — the meaningful check: anchor stays pixel-fixed.
{
  const b = { x: 0, y: 0, w: 100, h: 50, rot: 90 }
  const r = computeResize(b, 4, 10, 0) // world +x drag on BR
  // Verify the TL corner (anchor) is unchanged in world after the
  // resize: reconstruct anchor via center delta — cheap check is
  // that w/h changed but box still contains its own rot.
  ok('rot90: resizes', r.w !== 100 || r.h !== 50)
  // Anchor = TL corner. Its LOCAL offset from center is (-w/2,-h/2)
  // — changes with size. World position = center + R(rot)*local.
  const r90 = Math.PI / 2
  const worldOf = (b) => {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2
    const lx = -b.w / 2, ly = -b.h / 2 // TL corner, local frame
    return { x: cx + lx * Math.cos(r90) - ly * Math.sin(r90),
             y: cy + lx * Math.sin(r90) + ly * Math.cos(r90) }
  }
  const w0 = worldOf(b), w1 = worldOf(r)
  ok('rot90: TL anchor pixel-fixed', near(w0.x, w1.x, 1e-4) && near(w0.y, w1.y, 1e-4))
}
// Aspect lock: 200x100 → BR drag +40/+10 → ratio kept (w leads).
{
  const r = computeResize(box, 4, 40, 10, true)
  ok('aspect: ratio kept', near(r.w / r.h, 2))
}
// Min clamp: huge shrink stays ≥2.
{
  const r = computeResize(box, 4, -500, -500)
  ok('clamp: >=2', r.w >= 2 && r.h >= 2)
}

console.log(fails ? `\n${fails} FAILED` : '\nall resize checks passed')
process.exit(fails ? 1 : 0)
