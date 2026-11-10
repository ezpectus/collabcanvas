// RDP path simplification (T-21) — compiled geometry.ts, no deps.
import assert from 'node:assert'
import { simplifyPoints } from './.test-build/geometry.js'

let fails = 0
const ok = (n, c) => { console.log(`${c ? ' ok ' : 'FAIL'}  ${n}`); if (!c) fails++ }

// Straight line of 100 points → just the endpoints.
{
  const line = Array.from({ length: 100 }, (_, i) => ({ x: i, y: i * 0.5 }))
  const r = simplifyPoints(line, 1)
  ok('collinear -> 2 points', r.length === 2)
}
// A wave keeps its peaks.
{
  const wave = Array.from({ length: 200 }, (_, i) =>
    ({ x: i, y: Math.sin(i / 10) * 20 }))
  const r = simplifyPoints(wave, 1)
  ok('wave compressed', r.length < 60 && r.length > 10, `-> ${r.length}`)
  const maxY = Math.max(...r.map(p => p.y))
  ok('peaks survive', maxY > 19)
}
// Degenerate (all same point) → endpoints only.
{
  const same = Array.from({ length: 50 }, () => ({ x: 5, y: 5 }))
  ok('degenerate -> 2', simplifyPoints(same, 1).length === 2)
}
// Tiny paths pass through.
{
  const two = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
  ok('short path untouched', simplifyPoints(two, 1).length === 2)
}
// eps=0 keeps everything.
{
  const pts = [{ x: 0, y: 0 }, { x: 5, y: 0.5 }, { x: 10, y: 0 }]
  ok('eps=0 lossless', simplifyPoints(pts, 0).length === 3)
}

console.log(fails ? `\n${fails} FAILED` : '\nall rdp checks passed')
process.exit(fails ? 1 : 0)
