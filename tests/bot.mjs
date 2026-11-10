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

function client(name, token) {
  const conn = new signalR.HubConnectionBuilder()
    .withUrl(`${API}/hubs/document`,
      token ? { accessTokenFactory: () => token } : {})
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
  conn.onclose((e) =>
    console.log(`dbg ${name} closed`, e ? String(e).slice(0, 90) : 'clean'))
  conn.on('presence-state', (s) => { c.presenceState = s })
  conn.on('presence-left', (l) => c.presence.push({ left: l }))
  c.submit = (type, payload, doc = DOC) =>
    conn.invoke('SubmitOp', {
      docId: doc, clientId: name, clientSeq: ++c.clientSeq, type, payload,
    })
  c.submitAs = (type, payload, clientSeq) =>
    conn.invoke('SubmitOp', { docId: DOC, clientId: name, clientSeq, type, payload })
  c.join = (lastSeq = 0, doc = DOC) =>
    conn.invoke('JoinDocument', { docId: doc, clientId: name, lastSeq })
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
  selection: ['r-1'], color: '#fff' })
const pres = await waitFor(
  () => B.presence.find(p => p.clientId === 'bot-a'), 5000, 'B sees cursor')
ok('presence: B receives cursor', pres?.update?.cursor?.x === 7)
ok('presence: selection ids cross the wire',
  pres?.update?.selection?.includes('r-1'))

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

// --- T-26 stage 1: auth + server-owned presence name ------------------------------
const botLogin = `bot_${Date.now().toString(36)}`
const authPost = (path, body) => fetch(`${API}/auth/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body) })
const reg = await authPost('register', { login: botLogin, password: 'secretpw' })
ok('auth: register 200', reg.status === 200, `status=${reg.status}`)
ok('auth: duplicate register 409',
  (await authPost('register', { login: botLogin, password: 'secretpw' }))
    .status === 409)
const { token } = await reg.json()
ok('auth: login 200 + token',
  (await authPost('login', { login: botLogin, password: 'secretpw' }))
    .status === 200)
ok('auth: wrong password 401 (no enumeration)',
  (await authPost('login', { login: botLogin, password: 'nope123' }))
    .status === 401)
ok('auth: me resolves Bearer token',
  (await fetch(`${API}/auth/me`,
    { headers: { Authorization: `Bearer ${token}` } })).status === 200)
ok('auth: me rejects bad token',
  (await fetch(`${API}/auth/me`,
    { headers: { Authorization: 'Bearer forged' } })).status === 401)

// Presence name is server-owned: the hub stamps the resolved login,
// a client claiming a name gets ignored/overwritten. A fresh watcher
// joins — A/B/C were already stopped by the reconnect test.
const U = client(botLogin, token)
const W = client('bot-watcher')
await U.start(); await W.start(); await U.join(0); await W.join(0)
await U.conn.invoke('Presence', { docId: DOC, clientId: botLogin,
  cursor: { x: 1, y: 1 }, selection: [], color: '#fff', name: 'hacker' })
const seenU = await waitFor(() =>
  W.presence.find(p => p.clientId === botLogin), 5000)
ok('auth: presence name = server login, not claimed',
  seenU?.update?.name === botLogin,
  `seen=${JSON.stringify(seenU?.update ?? null)}`)
await U.conn.stop(); await W.conn.stop()

// --- T-26 stage 2: membership + roles --------------------------------------------------
// Owned doc (POST /docs by an authed user): members get roles, the
// rest of the world is denied. Unowned docs stay legacy-open —
// everything above ran anonymously and kept passing.
const u2 = `v_${Date.now().toString(36)}`, u3 = `e_${Date.now().toString(36)}`
const reg2 = await (await authPost('register',
  { login: u2, password: 'secretpw' })).json()
const reg3 = await (await authPost('register',
  { login: u3, password: 'secretpw' })).json()
const authed = (path, tk, init = {}) => fetch(`${API}${path}`, {
  ...init, headers: { 'Content-Type': 'application/json',
    Authorization: `Bearer ${tk}`, ...(init.headers ?? {}) } })

// Owned doc create → creator is owner.
const owned = await (await authed('/docs', token, { method: 'POST' })).json()
const OWN = owned.id
ok('authz: authed POST /docs creates owned doc',
  owned.role === 'owner' && OWN.length >= 8, `id=${OWN}`)

// Guest join → rejected (invoke throws on HubException).
const G = client('bot-guest')
await G.start()
const guestJoin = await G.join(0, OWN).catch(e => `denied:${e.message}`)
ok('authz: guest join on owned doc denied',
  String(guestJoin).includes('forbidden'), String(guestJoin).slice(0, 60))

// Authed non-member → also denied.
const N = client(u2, reg2.token)
await N.start()
const nonJoin = await N.join(0, OWN).catch(e => `denied:${e.message}`)
ok('authz: non-member join denied',
  String(nonJoin).includes('forbidden'), String(nonJoin).slice(0, 60))

// Guest op on owned doc → forbidden ack (not an error — a denial).
const gAck = await G.submit('Create',
  { id: 'g1', kind: 'rect', z: 'a1', props: { x: 0, y: 0, w: 1, h: 1 } }, OWN)
ok('authz: guest op forbidden', gAck.accepted === false &&
  gAck.reason === 'forbidden', gAck.reason)

// Owner seats viewer → viewer joins with role, ops denied.
ok('authz: owner seats viewer', (await authed(`/docs/${OWN}/members`,
  token, { method: 'POST',
    body: JSON.stringify({ login: u2, role: 'viewer' }) })).status === 204)
const vJoin = await N.join(0, OWN)
ok('authz: viewer joins with role', vJoin.role === 'viewer', vJoin.role)
const vAck = await N.submit('Create',
  { id: 'v1', kind: 'rect', z: 'a1', props: { x: 0, y: 0, w: 1, h: 1 } }, OWN)
ok('authz: viewer op denied (server, not UI)', vAck.accepted === false &&
  vAck.reason === 'forbidden', vAck.reason)

// Promote to editor → ops now pass — same socket, no rejoin.
ok('authz: owner promotes to editor', (await authed(`/docs/${OWN}/members`,
  token, { method: 'POST',
    body: JSON.stringify({ login: u2, role: 'editor' }) })).status === 204)
const eAck = await N.submit('Create',
  { id: 'e1', kind: 'rect', z: 'a2', props: { x: 0, y: 0, w: 1, h: 1 } }, OWN)
ok('authz: editor op accepted', eAck.accepted === true, eAck.reason)

// Revoke on a LIVE socket: remove member → next op forbidden.
ok('authz: owner revokes editor', (await authed(`/docs/${OWN}/members/${u2}`,
  token, { method: 'DELETE' })).status === 204)
const rAck = await N.submit('Create',
  { id: 'r1', kind: 'rect', z: 'a3', props: { x: 0, y: 0, w: 1, h: 1 } }, OWN)
ok('authz: revoked member denied on live socket',
  rAck.accepted === false && rAck.reason === 'forbidden', rAck.reason)

// Admin powers: seat admin; admin adds editor but can't seat admin.
ok('authz: owner seats admin', (await authed(`/docs/${OWN}/members`,
  token, { method: 'POST',
    body: JSON.stringify({ login: u3, role: 'admin' }) })).status === 204)
ok('authz: admin adds editor', (await authed(`/docs/${OWN}/members`,
  reg3.token, { method: 'POST',
    body: JSON.stringify({ login: u2, role: 'editor' }) })).status === 204)
ok('authz: admin cannot seat another admin',
  (await authed(`/docs/${OWN}/members`, reg3.token, { method: 'POST',
    body: JSON.stringify({ login: 'ghost', role: 'admin' }) }))
    .status === 403)
ok('authz: nobody mints owner via members endpoint',
  (await authed(`/docs/${OWN}/members`, token, { method: 'POST',
    body: JSON.stringify({ login: u2, role: 'owner' }) }))
    .status === 400)

// Discovery + audit: owned doc hidden from strangers, open to members.
const guestDocs = await (await fetch(`${API}/docs`)).json()
ok('authz: /docs hides owned doc from guest',
  !guestDocs.includes(OWN), `n=${guestDocs.length}`)
const memberDocs = await (await authed('/docs', reg3.token)).json()
ok('authz: /docs shows owned doc to member', memberDocs.includes(OWN))
ok('authz: /ops denied to stranger',
  (await fetch(`${API}/ops?doc=${OWN}`)).status === 403)
ok('authz: /ops readable by member',
  (await authed(`/ops?doc=${OWN}&n=5`, reg3.token)).status === 200)

// T-27: rename via PATCH /docs/{id} — admin+ only, meta readable
// by any member.
ok('meta: rename denied to editor member', (await authed(
  `/docs/${OWN}`, reg2.token, { method: 'PATCH',
    body: JSON.stringify({ name: 'stolen' }) })).status === 403)
ok('meta: owner renames', (await authed(`/docs/${OWN}`, token,
  { method: 'PATCH', body: JSON.stringify({ name: 'board one' }) }))
    .status === 204)
const meta = await (await authed(`/docs/${OWN}/meta`, reg3.token)).json()
ok('meta: name readable by member', meta.name === 'board one', meta.name)
ok('meta: name hidden from stranger',
  (await fetch(`${API}/docs/${OWN}/meta`)).status === 403)

// Delist: stranger 403, owner 204 (reversible delist, journal lives).
ok('authz: DELETE /docs denied to stranger',
  (await fetch(`${API}/docs/${OWN}`, { method: 'DELETE' }))
    .status === 403)
ok('authz: DELETE /docs allowed for owner',
  (await authed(`/docs/${OWN}`, token, { method: 'DELETE' }))
    .status === 204)

await G.conn.stop(); await N.conn.stop()

// --- T-26 stage 3: share links (guest viewer/editor) -----------------------------------
const mkLink = async (role) => (await (await authed(`/docs/${OWN}/links`,
  token, { method: 'POST', body: JSON.stringify({ role }) })).json()).token

// Bad grant → still denied.
const GB = client('bot-gbad')
await GB.start()
GB.join = (lastSeq = 0, doc = OWN, grant = null) =>
  GB.conn.invoke('JoinDocument', { docId: doc, clientId: 'bot-gbad',
    lastSeq, grant })
const badJoin = await GB.join(0, OWN, 'forged-token')
  .catch(e => `denied:${e.message}`)
ok('links: forged grant denied',
  String(badJoin).includes('forbidden'), String(badJoin).slice(0, 70))
await GB.conn.stop()

// Viewer link → guest joins with role=viewer, ops denied.
const vTok = await mkLink('viewer')
const GV = client('bot-gview')
await GV.start()
GV.join = (lastSeq = 0, doc = OWN, grant = vTok) =>
  GV.conn.invoke('JoinDocument', { docId: doc, clientId: 'bot-gview',
    lastSeq, grant })
const gvJoin = await GV.join()
ok('links: viewer grant joins as guest', gvJoin.role === 'viewer', gvJoin.role)
const gvAck = await GV.submit('Create',
  { id: 'gv1', kind: 'rect', z: 'a4', props: { x: 0, y: 0, w: 1, h: 1 } }, OWN)
ok('links: viewer-grant op denied', gvAck.accepted === false &&
  gvAck.reason === 'forbidden', gvAck.reason)

// Editor link → guest joins with role=editor, ops accepted.
const eTok = await mkLink('editor')
const GE = client('bot-gedit')
await GE.start()
GE.join = (lastSeq = 0, doc = OWN, grant = eTok) =>
  GE.conn.invoke('JoinDocument', { docId: doc, clientId: 'bot-gedit',
    lastSeq, grant })
const geJoin = await GE.join()
ok('links: editor grant joins as guest', geJoin.role === 'editor', geJoin.role)
const geAck = await GE.submit('Create',
  { id: 'ge1', kind: 'rect', z: 'a5', props: { x: 0, y: 0, w: 1, h: 1 } }, OWN)
ok('links: editor-grant op accepted', geAck.accepted === true, geAck.reason)

// Link is capped: admin/owner roles are refused at creation.
ok('links: admin link refused', (await authed(`/docs/${OWN}/links`,
  token, { method: 'POST', body: JSON.stringify({ role: 'admin' }) }))
    .status === 400)
ok('links: owner link refused', (await authed(`/docs/${OWN}/links`,
  token, { method: 'POST', body: JSON.stringify({ role: 'owner' }) }))
    .status === 400)
ok('links: member can\'t mint links', (await authed(`/docs/${OWN}/links`,
  reg2.token, { method: 'POST', body: JSON.stringify({ role: 'viewer' }) }))
    .status === 403)

// Revoke kills the LIVE socket: editor-grant guest's next op denied.
ok('links: owner revokes editor link', (await authed(
  `/docs/${OWN}/links/${eTok}`, token, { method: 'DELETE' }))
    .status === 204)
const revAck = await GE.submit('Create',
  { id: 'rev1', kind: 'rect', z: 'a6', props: { x: 0, y: 0, w: 1, h: 1 } }, OWN)
ok('links: revoked grant denied on live socket',
  revAck.accepted === false && revAck.reason === 'forbidden', revAck.reason)
await GV.conn.stop(); await GE.conn.stop()

// Link expiry: minted-with-ttl works now; a grant whose expiry is
// already past must not resolve (written straight into Redis —
// the API clamps ttl >=1h so we can't wait for a real lapse).
ok('links: ttlHours accepted on mint', (await authed(`/docs/${OWN}/links`,
  token, { method: 'POST',
    body: JSON.stringify({ role: 'viewer', ttlHours: 1 }) }))
    .status === 200)
ok('links: ttlHours out of range refused', (await authed(`/docs/${OWN}/links`,
  token, { method: 'POST',
    body: JSON.stringify({ role: 'viewer', ttlHours: 0 }) }))
    .status === 400)
try {
  const { execSync } = await import('node:child_process')
  execSync(`docker exec collabcanvas-redis-1 redis-cli hset ` +
    `doc:${OWN}:links stale-grant "viewer|1"`)
  const GS = client('bot-gstale')
  await GS.start()
  const staleJoin = await GS.conn.invoke('JoinDocument',
    { docId: OWN, clientId: 'bot-gstale', lastSeq: 0, grant: 'stale-grant' })
    .catch(e => `denied:${e.message}`)
  ok('links: expired grant denied', String(staleJoin).includes('forbidden'),
    String(staleJoin).slice(0, 60))
  await GS.conn.stop()
} catch (e) {
  ok('links: expired grant denied', false,
    `redis seed failed: ${String(e).slice(0, 50)}`)
}

// --- T-36: image blobs ------------------------------------------------------------------
const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52]) // png magic + ihdr head
const blobPost = (body, tk, type = 'image/png') =>
  fetch(`${API}/docs/${OWN}/blobs`, { method: 'POST',
    headers: { 'Content-Type': type, Authorization: `Bearer ${tk}` },
    body })
const bRes = await blobPost(png, reg3.token)
ok('blobs: editor member uploads', bRes.status === 200, `s=${bRes.status}`)
const blobId = bRes.ok ? (await bRes.json()).id : null
ok('blobs: member reads blob', blobId &&
  (await authed(`/blobs/${blobId}`, reg3.token)).status === 200)
ok('blobs: stranger 403', blobId &&
  (await fetch(`${API}/blobs/${blobId}`)).status === 403)
ok('blobs: viewer-grant holder reads', blobId && vTok &&
  (await fetch(`${API}/blobs/${blobId}?grant=${vTok}`)).status === 200)
ok('blobs: bad type refused',
  (await blobPost(png, reg3.token, 'text/html')).status === 400)
ok('blobs: oversize refused', (await blobPost(
  Buffer.alloc(5_000_001), reg3.token)).status === 400)
ok('blobs: viewer member cannot upload',
  (await authed(`/docs/${OWN}/members`, token, { method: 'POST',
    body: JSON.stringify({ login: u2, role: 'viewer' }) }),
   await blobPost(png, reg2.token)).status === 403)
ok('blobs: nosniff header set', blobId &&
  (await authed(`/blobs/${blobId}`, reg3.token))
    .headers.get('x-content-type-options') === 'nosniff')

// --- logout on a LIVE socket: the session dies, the socket's
// member rights must die with it — per-op token re-resolution.
const u4 = `lo_${Date.now().toString(36)}`
const reg4 = await (await authPost('register',
  { login: u4, password: 'secretpw' })).json()
const OWN4 = (await (await authed('/docs', reg4.token,
  { method: 'POST' })).json()).id
const L = client(u4, reg4.token)
await L.start()
await L.join(0, OWN4)
const loAck1 = await L.submit('Create',
  { id: 'lo1', kind: 'rect', z: 'a1', props: { x: 0, y: 0, w: 1, h: 1 } }, OWN4)
ok('logout: owner op accepted pre-logout', loAck1.accepted === true)
await authed('/auth/logout', reg4.token, { method: 'POST' })
const loAck2 = await L.submit('Create',
  { id: 'lo2', kind: 'rect', z: 'a2', props: { x: 0, y: 0, w: 1, h: 1 } }, OWN4)
ok('logout: live socket loses rights on next op',
  loAck2.accepted === false && loAck2.reason === 'forbidden', loAck2.reason)
await L.conn.stop()

// --- T-24/T-32: journal tail endpoint + doc delisting ----------------------------------
const tailOps = await (await fetch(`${API}/ops?doc=${DOC}&n=5`)).json()
ok('ops endpoint: journal tail readable',
  tailOps.length > 0 && typeof tailOps.at(-1).seq === 'number',
  `tail=${tailOps.length}`)
ok('ops endpoint: tail ends near last seq',
  tailOps.at(-1).seq >= (A.ops.at(-1)?.seq ?? 0) - 1)

const del = await fetch(`${API}/docs/${encodeURIComponent(DOC)}`,
  { method: 'DELETE' })
ok('unlist: DELETE accepted', del.status === 204, `status=${del.status}`)
const listAfter = await (await fetch(`${API}/docs`)).json()
ok('unlist: doc gone from /docs (bot self-cleans)',
  !listAfter.includes(DOC))

// --- hard delete: owner-only destroy strips every trace; tombstone
// blocks the legacy-open resurrection path for members AND links.
const u5 = `dd_${Date.now().toString(36)}`
const reg5 = await (await authPost('register',
  { login: u5, password: 'secretpw' })).json()
const u6 = `dm_${Date.now().toString(36)}`
const reg6 = await (await authPost('register',
  { login: u6, password: 'secretpw' })).json()
const OWN5 = (await (await authed('/docs', reg5.token,
  { method: 'POST' })).json()).id
await authed(`/docs/${OWN5}/members`, reg5.token,
  { method: 'POST', body: JSON.stringify({ login: u6, role: 'editor' }) })
const ddLink = (await (await authed(`/docs/${OWN5}/links`, reg5.token,
  { method: 'POST', body: JSON.stringify({ role: 'viewer' }) })).json()).token
const M = client(u6, reg6.token)
await M.start()
ok('destroy: member joined pre-delete',
  (await M.join(0, OWN5)).role === 'editor')
const DDG = client('g')
await DDG.start()
DDG.join = (lastSeq = 0, doc = OWN5, grant = ddLink) =>
  DDG.conn.invoke('JoinDocument',
    { docId: doc, clientId: 'bot-ddguest', lastSeq, grant })
ok('destroy: link guest joined pre-delete',
  (await DDG.join()).role === 'viewer')
ok('destroy: non-owner hard delete denied',
  (await authed(`/docs/${OWN5}?hard=1`, reg6.token,
    { method: 'DELETE' })).status === 403)
ok('destroy: plain delete still needs admin+',
  (await authed(`/docs/${OWN5}`, reg6.token,
    { method: 'DELETE' })).status === 403)
ok('destroy: owner hard delete accepted',
  (await authed(`/docs/${OWN5}?hard=1`, reg5.token,
    { method: 'DELETE' })).status === 204)
ok('destroy: member ops denied after delete',
  (await M.submit('Create',
    { id: 'dd1', kind: 'rect', z: 'a1', props: { x: 0, y: 0, w: 1, h: 1 } },
    OWN5)).accepted === false)
ok('destroy: member rejoin denied (tombstone)',
  String(await M.join(1, OWN5).catch(e => e)).includes('forbidden'))
ok('destroy: link guest denied after delete',
  String(await DDG.join().catch(e => e)).includes('forbidden'))
ok('destroy: doc gone from /docs',
  !(await (await fetch(`${API}/docs`)).json()).includes(OWN5))
ok('destroy: /ops denied on dead doc',
  (await authed(`/ops?doc=${OWN5}`, reg5.token)).status === 403)
await M.conn.stop(); await DDG.conn.stop()

console.log(failures === 0
  ? `\n${tag}: ALL SCENARIOS PASSED`
  : `\n${tag}: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
