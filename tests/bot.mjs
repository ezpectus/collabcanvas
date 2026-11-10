// E2E test bot — two real SignalR clients against a live API.
// Verifies the wire contract the browser depends on, without a browser:
//   join (tail + snapshot paths), op broadcast fanout, server seq,
//   dedup on retry, validation rejection, rate limiting, presence,
//   reconnect resync.
//
//   docker compose -p collabcanvas up -d api redis   (or full stack)
//   node tests/bot.mjs
//   API=http://host:8090 node tests/bot.mjs
//
// Uses the web app's own @microsoft/signalr (CJS) via createRequire —
// no extra dependencies, Node 24+ provides fetch/WebSocket natively.
// Exit 0 = every scenario passed.

import { createRequire } from 'node:module'
const require = createRequire(new URL('../web/package.json', import.meta.url))
const signalR = require('@microsoft/signalr')

const API = process.env.API ?? 'http://localhost:8090'
const DOC = `bot-${Date.now()}`
const tag = `bot-${Date.now()}`

let failures = 0
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? ' ok ' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!cond) failures++
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function client(name) {
  const conn = new signalR.HubConnectionBuilder()
    .withUrl(`${API}/hubs/document`)
    .withAutomaticReconnect([0, 0, 0]) // we drive rejoin manually
    .build()
  const c = {
    conn, name,
    clientSeq: 0,
    ops: [],           // every 'op' broadcast seen
    presence: [],      // every 'presence' broadcast seen
    presenceState: null,
  }
  conn.on('op', (op) => c.ops.push(op))
  conn.on('presence', (b) => c.presence.push(b))
  conn.on('presence-state', (s) => { c.presenceState = s })
  conn.on('presence-left', (l) => c.presence.push({ left: l }))
  c.submit = (type, payload) =>
    conn.invoke('SubmitOp', {
      docId: DOC, clientId: name, clientSeq: ++c.clientSeq, type, payload,
    })
  c.submitAs = (type, payload, clientSeq) =>
    conn.invoke('SubmitOp', { docId: DOC, clientId: name, clientSeq, type, payload })
  c.join = (lastSeq = 0) =>
    conn.invoke('JoinDocument', { docId: DOC, clientId: name, lastSeq })
  c.start = () => conn.start()
  return c
}

const waitFor = async (fn, timeoutMs, what) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = fn()
    if (v) return v
    await sleep(50)
  }
  return null
}

console.log(`${tag}  api=${API}  doc=${DOC}`)

// --- connect + join ----------------------------------------------------------
const A = client('bot-a')
const B = client('bot-b')
try {
  await A.start(); await B.start()
  ok('connect: both clients up', true)
} catch (e) {
  ok('connect: both clients up', false, String(e).slice(0, 80))
  process.exit(1)
}

const joinA = await A.join(0)
ok('join: A on empty doc', joinA.ops.length === 0 && joinA.lastSeq === 0,
  `lastSeq=${joinA.lastSeq}`)
const joinB = await B.join(0)
ok('join: B in the room', joinB.lastSeq === 0)

// --- op submit + cross-client fanout ------------------------------------------
// z must satisfy the FractionalIndex invariant — a key may never end
// in '0' (server rejects it; that rejection is itself tested below).
const rect = { id: 'r-1', kind: 'rect', z: 'a1',
  props: { x: 10, y: 20, w: 100, h: 60, fill: '#3d5af1' } }
const ack1 = await A.submit('Create', rect)
ok('submit: accepted with seq', ack1.accepted === true && ack1.seq > 0,
  `seq=${ack1.seq}`)

const seenB = await waitFor(
  () => B.ops.find(o => o.payload.id === 'r-1'), 5000, 'B sees r-1')
ok('fanout: B received the create', seenB !== null && seenB.seq === ack1.seq)
ok('fanout: op carries clientId+clientSeq',
  seenB?.clientId === 'bot-a' && seenB?.clientSeq === 1)

// --- validation: malformed ops rejected ----------------------------------------
const bad = await A.submit('Create',
  { id: 'bad:1', kind: 'rect', z: 'b1', props: {} })
ok('validate: ":" in id rejected', bad.accepted === false &&
  bad.reason.startsWith('invalid:'), bad.reason)
const badz = await A.submit('Create',
  { id: 'badz', kind: 'rect', z: 'b0', props: {} })
ok('validate: z ending in 0 rejected', badz.accepted === false)
const huge = await A.submit('Patch',
  { id: 'r-1', props: { text: 'x'.repeat(5000) } })
ok('validate: >4KB text on Patch rejected', huge.accepted === false)

// --- dedup: retry with same clientSeq -----------------------------------------
const ackDup = await A.submitAs('Create', rect, 1)
ok('dedup: same clientSeq -> duplicate ack', ackDup.seq === ack1.seq &&
  ackDup.reason === 'duplicate', `seq=${ackDup.seq} reason=${ackDup.reason}`)
await sleep(300)
// Design, not a bug: the router RE-BROADCASTS the original op on a
// dedup hit — it un-stalls the retrying client's pending, and clients
// drop seq <= lastSeq. What must hold: every r-1 Create broadcast
// carries the SAME seq (a real second op would mint seq 2+).
const creates = B.ops.filter(o => o.payload.id === 'r-1' && o.type === 'Create')
ok('dedup: rebroadcast keeps same seq',
  creates.length >= 1 && creates.every(o => o.seq === ack1.seq),
  `broadcasts=${creates.length}`)

// --- patch + ordering -----------------------------------------------------------
const ackP = await A.submit('Patch', { id: 'r-1', props: { x: 500 } })
ok('patch: seq is monotonic', ackP.seq === ack1.seq + 1, `seq=${ackP.seq}`)

// --- presence --------------------------------------------------------------------
await A.conn.invoke('Presence', {
  docId: DOC, clientId: 'bot-a', cursor: { x: 7, y: 9 },
  selection: [], color: '#fff' })
const pres = await waitFor(
  () => B.presence.find(p => p.clientId === 'bot-a'), 5000, 'B sees cursor')
ok('presence: B receives cursor', pres?.update?.cursor?.x === 7)

// --- late joiner gets the tail ----------------------------------------------------
const C = client('bot-c')
await C.start()
const joinC = await C.join(0)
ok('late join: tail carries missed ops',
  joinC.ops.some(o => o.payload.id === 'r-1' && o.type === 'Create'),
  `ops=${joinC.ops.length}`)
ok('late join: presence snapshot for C', C.presenceState !== null &&
  'bot-a' in C.presenceState, JSON.stringify(Object.keys(C.presenceState ?? {})))

// --- rate limiting: burst past the bucket -------------------------------------------
// Bucket: ~120/s sustained, 240 burst. Fire 400 parallel submits.
const rl = await Promise.all(Array.from({ length: 400 }, (_, i) =>
  A.submitAs('Patch', { id: 'r-1', props: { y: i } }, 1000 + i)))
const rejected = rl.filter(a => a.accepted === false && a.reason === 'rate-limited')
ok('rate-limit: burst capped', rejected.length > 50,
  `rejected=${rejected.length}/400`)

// --- reconnect resync ------------------------------------------------------------------
await A.conn.stop()
const ackB2 = await B.submit('Create',
  { id: 'r-2', kind: 'ellipse', z: 'a2', props: { x: 1, y: 1, w: 10, h: 10 } })
await A.conn.start()
const rejoin = await A.join(A.ops.at(-1)?.seq ?? 0)
ok('reconnect: tail fills the gap',
  rejoin.ops.some(o => o.seq === ackB2.seq), `ops=${rejoin.ops.length}`)

await B.conn.stop()
await C.conn.stop()
await A.conn.stop()

console.log(failures === 0
  ? `\n${tag}: ALL SCENARIOS PASSED`
  : `\n${tag}: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
