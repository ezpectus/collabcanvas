// Perf harness (T-20) — REAL numbers, replaces "checked by eye".
//
// Part 1 (client-side hot path, headless): compile the actual TS
// modules and measure what a frame costs on the CPU:
//   npx tsc src/{geometry,model,quadtree,protocol}.ts \
//     --outDir ../tests/.perf-build --module esnext --skipLibCheck   (from web/)
//   node ../tests/perf.mjs
//
// Part 2 (wire latency): submit→echo RTT through the live API —
// run with the stack up, `node tests/perf.mjs` does both parts.
//
// Numbers land in README — honest measurement, not adjectives.

import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
const requireWeb = createRequire(new URL('../web/package.json', import.meta.url))
const requireSelf = createRequire(import.meta.url)
const signalR = requireWeb('@microsoft/signalr')

const { DocModel } = requireSelf('./.perf-build/model.js')
const { SceneIndex } = requireSelf('./.perf-build/quadtree.js')

const ms = (t0) => (performance.now() - t0).toFixed(1)
const bench = (name, fn) => { const t = performance.now(); const r = fn(); console.log(`${name.padEnd(44)} ${ms(t)}ms`); return r }

// --- document sizes ---------------------------------------------------------
for (const n of [10_000, 50_000]) {
  const model = new DocModel()
  bench(`fill ${n} rects (apply Create ops)`, () => {
    for (let i = 0; i < n; i++)
      model.apply({
        docId: 'perf', seq: i + 1, clientId: 'b', clientSeq: i + 1,
        type: 'Create',
        payload: { id: `o${i}`, kind: 'rect', z: `z${i}`,
          props: { x: (i * 37) % 4000, y: (i * 91) % 3000, w: 40, h: 30 } },
      })
  })
  const index = new SceneIndex()
  bench(`SceneIndex build @${n}`, () => index.visibleIn(model,
    { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 }))
  bench(`objects() scan @${n}`, () => model.objects())
  // Frame-shaped work: cull to a 1920×1080 viewport + hit test.
  const view = { x0: 0, y0: 0, x1: 1920, y1: 1080 }
  bench(`visibleIn(view) @${n} -> drawn`, () =>
    index.visibleIn(model, view).length)
  bench(`hitTest center @${n}`, () =>
    index.hitTest(model, 2000, 1500)?.id ?? 'miss')
  console.log()
}

// --- wire RTT (needs live API) ----------------------------------------------
const API = process.env.API ?? 'http://localhost:8090'
const DOC = `perf-${Date.now()}`
try {
  const conn = new signalR.HubConnectionBuilder()
    .withUrl(`${API}/hubs/document`).build()
  const echoes = new Map() // clientSeq -> t0
  conn.on('op', (op) => {
    const t0 = echoes.get(op.clientSeq)
    if (t0 !== undefined) echoes.set(op.clientSeq, performance.now() - t0)
  })
  await conn.start()
  await conn.invoke('JoinDocument', { docId: DOC, clientId: 'perf', lastSeq: 0 })

  const N = 200
  for (let i = 0; i < N; i++) {
    echoes.set(i + 1, performance.now())
    await conn.invoke('SubmitOp', {
      docId: DOC, clientId: 'perf', clientSeq: i + 1, type: 'Patch',
      payload: { id: 'o1', props: { x: i } },
    })
  }
  await new Promise(r => setTimeout(r, 1500)) // drain the last echoes
  // Un-echoed entries still hold their (large) t0 — keep only real
  // round-trip diffs (<10s); count the misses honestly.
  const all = [...echoes.values()]
  const rtts = all.filter(v => v < 10_000).sort((a, b) => a - b)
  const missed = all.length - rtts.length
  if (rtts.length === 0) { console.log(`op RTT: no echoes (${missed} missed)`); }
  else {
    const p = (q) => rtts[Math.floor(rtts.length * q)].toFixed(1)
    console.log(`op RTT submit->echo, n=${rtts.length}/${N}` +
      `${missed ? ` (+${missed} missed)` : ''}:` +
      ` p50=${p(0.5)}ms p95=${p(0.95)}ms p99=${p(0.99)}ms`)
  }
  await conn.stop()
} catch (e) {
  console.log(`wire bench skipped (API down): ${String(e).slice(0, 60)}`)
}
