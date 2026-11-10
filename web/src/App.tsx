import { useCallback, useEffect, useRef, useState } from 'react'
import { Session } from './session'
import { Renderer, type FrameStats } from './renderer'
import { SceneIndex } from './quadtree'
import { Editor, type Tool } from './editor'
import { boundsOf, num, str } from './geometry'
import type { DocModel } from './model'
import { FractionalIndex } from './fractionalIndex'

type ConnState = 'idle' | 'connecting' | 'joined' | 'error'

const COLORS = ['#e57373', '#81c784', '#64b5f6', '#ffb74d', '#ba68c8', '#4db6ac']
const TOOLS: Tool[] = ['select', 'rect', 'ellipse', 'line', 'text', 'path']

// T-9: editing tools + optimistic apply. Pan lives on middle/right
// drag or Space+drag — left drag belongs to the active tool.
// T-15: DOM overlay for inline text editing. Positioned over the
// object's screen rect; keystrokes apply LOCAL patches (remotes see
// the result at commit — wire traffic stays at one Patch per edit).
// Enter/blur commits, Shift+Enter newline, Escape reverts locally.
function TextEditor({ id, orig, session: s, view, onClose }: {
  id: string
  orig: string
  session: Session
  view: { x: number; y: number; scale: number }
  onClose: (commit: boolean, value?: string) => void
}) {
  const obj = s.model.objects().find((o) => o.id === id)
  if (!obj) return null
  const b = boundsOf(obj)
  if (!b) return null
  const size = typeof obj.props['fontSize'] === 'number'
    ? obj.props['fontSize'] : 16
  return (
    <textarea
      className="text-editor"
      autoFocus
      defaultValue={orig}
      style={{
        left: b.x0 * view.scale + view.x,
        top: b.y0 * view.scale + view.y - size * view.scale * 0.8,
        width: Math.max(80, (b.x1 - b.x0) * view.scale + 40),
        fontSize: size * view.scale,
      }}
      onChange={(e) =>
        s.applyLocal('Patch', { id, props: { text: e.currentTarget.value } })}
      onBlur={(e) => onClose(true, e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') onClose(false)
        else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          onClose(true, e.currentTarget.value)
        }
      }}
    />
  )
}

/** T-36: numeric inspector — x/y/w/h/rot direct input for a single
 *  selected box-kind object. Commits through Editor.applyProps so
 *  undo and the wire op see the change like a drag would. */
function Inspector({ editor, model }: {
  editor: Editor; model: DocModel
}) {
  const sel = editor.selected
  // T-40: multi-select shows the union box — x/y inputs translate the
  // whole group numerically (same op path as arrow-nudge).
  if (sel.size > 1) {
    let u: { x0: number; y0: number; x1: number; y1: number } | null = null
    for (const sid of sel) {
      const so = model.objects().find((x) => x.id === sid)
      const b = so && boundsOf(so)
      if (b) u = u ? { x0: Math.min(u.x0, b.x0), y0: Math.min(u.y0, b.y0),
                       x1: Math.max(u.x1, b.x1), y1: Math.max(u.y1, b.y1) }
                   : b
    }
    if (!u) return null
    const box = u
    return (
      <aside className="history-panel inspector-panel">
        <b>{sel.size} objects · union</b>
        {([['x', box.x0], ['y', box.y0]] as [string, number][]).map(([k, v]) => (
          <div key={k} className="hist-row">
            <span className="hist-seq">{k}</span>
            <input className="insp-input" type="number" step="1"
              key={`${k}:${v}`}
              defaultValue={Math.round(v * 10) / 10}
              onBlur={(e) => {
                const nv = parseFloat(e.target.value)
                if (!Number.isFinite(nv)) return
                if (k === 'x') editor.translateBy(nv - box.x0, 0)
                else editor.translateBy(0, nv - box.y0)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                e.stopPropagation()
              }} />
          </div>
        ))}
        <div className="hist-row"><span className="hist-seq">w·h</span>
          <span className="hist-who">
            {Math.round(box.x1 - box.x0)} × {Math.round(box.y1 - box.y0)}
          </span></div>
      </aside>
    )
  }
  if (sel.size !== 1) return null
  const id = [...sel][0]!
  const o = model.objects().find((x) => x.id === id)
  if (!o) return null
  // Line endpoints are numeric too — editable like box x/y. Path
  // points are an array: no honest scalar input, hidden entirely.
  const fields: [string, number][] = o.kind === 'line'
    ? [['x1', num(o.props, 'x1')], ['y1', num(o.props, 'y1')],
       ['x2', num(o.props, 'x2')], ['y2', num(o.props, 'y2')],
       ['lineWidth', num(o.props, 'lineWidth', 2)]]
    : o.props['x'] === undefined
    // Path: points array has no scalar input, but lineWidth/opacity
    // do — show those rather than hiding the panel entirely.
    ? (o.kind === 'path'
        ? [['lineWidth', num(o.props, 'lineWidth', 2)]] : [])
    : [['x', num(o.props, 'x')], ['y', num(o.props, 'y')],
       ['w', num(o.props, 'w', 1)], ['h', num(o.props, 'h', 1)],
       ['rot', num(o.props, 'rot')]]
  if (!fields.length) return null
  if (o.kind === 'text')
    fields.push(['fontSize', num(o.props, 'fontSize', 16)])
  if (o.kind === 'rect')
    fields.push(['radius', num(o.props, 'radius')])
  fields.push(['opacity', num(o.props, 'opacity', 1)]) // all kinds
  return (
    <aside className="history-panel inspector-panel">
      <b>{o.kind} · {id.slice(0, 8)}</b>
      {(o.kind === 'line' || o.kind === 'path') && (
        <div className="hist-row">
          <span className="hist-seq">dash</span>
          <select className="insp-input" value={str(o.props, 'dash') || 'solid'}
            onChange={(e) =>
              editor.applyProps(id, { dash: e.target.value })}>
            <option>solid</option><option>dashed</option><option>dotted</option>
          </select>
        </div>
      )}
      {o.kind === 'text' && (
        <div className="hist-row">
          <span className="hist-seq">align</span>
          <select className="insp-input" value={str(o.props, 'align') || 'left'}
            onChange={(e) =>
              editor.applyProps(id, { align: e.target.value })}>
            <option>left</option><option>center</option><option>right</option>
          </select>
        </div>
      )}
      {fields.map(([k, v]) => (
        <div key={k} className="hist-row">
          <span className="hist-seq">{k}</span>
          <input className="insp-input" type="number"
            step={k === 'opacity' ? 0.05 : 1}
            // key+defaultValue: uncontrolled so typing doesn't fight
            // the wire echo; v in key remounts on remote/local prop
            // change so the panel never shows stale numbers.
            key={`${id}:${k}:${v}`}
            defaultValue={Math.round(v * 10) / 10}
            disabled={!!o.props['locked']}
            onBlur={(e) => {
              const nv = parseFloat(e.target.value)
              if (Number.isFinite(nv)) editor.applyProps(id, {
                [k]: k === 'opacity' ? Math.min(1, Math.max(0, nv)) : nv })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              e.stopPropagation() // don't let canvas keys eat Enter/Esc
            }} />
        </div>
      ))}
    </aside>
  )
}

export default function App() {
  const [state, setState] = useState<ConnState>('idle')
  const [stats, setStats] = useState<FrameStats | null>(null)
  const [lastSeq, setLastSeq] = useState(0)
  const [tool, setTool] = useState<Tool>('select')
  const [error, setError] = useState<string | null>(null)
  // T-19: current doc from ?doc=; known docs for the picker.
  const [docId, setDocId] = useState(
    () => new URLSearchParams(location.search).get('doc') ?? 'demo')
  // T-26 stage 3: share-link grant travels with the join request.
  const [grant] = useState(
    () => new URLSearchParams(location.search).get('grant'))
  const [docList, setDocList] = useState<string[]>([])
  // T-15: inline text editing — {id, orig} while the overlay is open.
  const [editing, setEditing] = useState<{ id: string; orig: string } | null>(null)
  const editingRef = useRef<{ id: string; orig: string } | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sessionRef = useRef<Session | null>(null)
  const rendererRef = useRef<Renderer | null>(null)
  const indexRef = useRef(new SceneIndex())
  const editorRef = useRef<Editor | null>(null)
  const clientId = useRef(`web-${Math.random().toString(36).slice(2, 8)}`)
  const color = useRef(COLORS[Math.floor(Math.random() * COLORS.length)]!)
  const panDrag = useRef<{ x: number; y: number } | null>(null)
  const lastPos = useRef({ x: 0, y: 0 }) // for selection-only updates
  const seenMouse = useRef(false)
  const spaceDown = useRef(false)
  const statTick = useRef(0)

  const session = (): Session => (sessionRef.current ??= new Session())

  useEffect(() => {
    const r = new Renderer(
      canvasRef.current!,
      session().model,
      indexRef.current,
      () => session().cursors.values(),
      () => editorRef.current?.selectionQuads() ?? [],
      () => editorRef.current?.marqueeRect() ?? null,
      () => editorRef.current?.handlePoints() ?? [],
      () => editorRef.current?.guides ?? [],
    )
    rendererRef.current = r
    r.blobUrl = (id) => session().blobUrl(id)
    r.onFrame = (s) => { if (++statTick.current % 6 === 0) setStats({ ...s }) }
    r.start()
    return () => r.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const markDirty = useCallback(() => {
    rendererRef.current?.markDirty()
    setLastSeq(session().model.lastSeq)
  }, [])

  /** Open the inline text overlay for an object id (T-15). */
  const openEdit = useCallback((id: string) => {
    const o = session().model.objects().find((x) => x.id === id)
    if (!o || o.kind !== 'text') return
    const orig = typeof o.props['text'] === 'string' ? o.props['text'] : ''
    const st = { id, orig }
    editingRef.current = st
    setEditing(st)
  }, [])

  const closeEdit = useCallback((commit: boolean, value?: string) => {
    const st = editingRef.current
    if (!st) return
    if (commit && value !== undefined)
      editorRef.current?.commitText(st.id, value) // undo-tracked
    else if (!commit)
      session().applyLocal('Patch', { id: st.id, props: { text: st.orig } })
    editingRef.current = null
    setEditing(null)
    markDirty()
  }, [markDirty])

  /** After a gesture: the editor may have requested an edit overlay. */
  const drainEditRequest = useCallback(() => {
    const id = editorRef.current?.takeEditRequest()
    if (id) openEdit(id)
  }, [openEdit])

  const editor = useCallback((): Editor =>
    (editorRef.current ??= new Editor(session(), indexRef.current, markDirty)),
  [markDirty])

  // T-24: audit view of the journal tail — who did what, not a time
  // machine (hist deeper than MAXLEN doesn't exist).
  const [hist, setHistory] = useState<
    { seq: number; type: string; clientId: string }[] | null>(null)

  // T-28: layers panel — the find-your-object surface. At 10k objects
  // canvas clicking alone can't locate things; z-sorted list can.
  const [showLayers, setShowLayers] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  // T-26 stage 1: session token in localStorage — survives reload,
  // guest = no token (legacy editor; roles land in stage 2).
  const [token, setToken] = useState(
    () => localStorage.getItem('cc_token'))
  const [login, setLogin] = useState(
    () => localStorage.getItem('cc_login'))
  const [authErr, setAuthErr] = useState('')
  // T-26 stage 2: server-resolved role on the joined doc (cosmetic).
  const [role, setRole] = useState<string | null>(null)
  // T-26 stage 4: share panel — mint grant links + seat members.
  const [showShare, setShowShare] = useState(false)
  const [shareErr, setShareErr] = useState('')
  const [memberList, setMemberList] = useState<Record<string, string> | null>(null)
  const canManage = role === 'owner' || role === 'admin'
  const authedFetch = useCallback(async (path: string,
    init?: RequestInit) => fetch(path, {
      ...init, headers: { 'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } }),
    [token])
  /** Uncontrolled inputs in the share panel — one cast instead of
      repeating getElementById + as at every call site. */
  const field = <T extends HTMLElement = HTMLInputElement>(id: string) =>
    document.getElementById(id) as T | null
  // Owned docs are member-only on the server — an anonymous /docs
  // would hide them from their own owner's picker.
  const refreshDocs = useCallback(async () => {
    try { setDocList(await (await authedFetch('/docs')).json()) }
    catch { /* discovery degrades, doc still works */ }
  }, [authedFetch])
  const copyLink = useCallback(async (r: 'viewer' | 'editor') => {
    try {
      const ttlH = field('link-ttl')?.valueAsNumber
      const body: Record<string, unknown> = { role: r }
      if (ttlH && ttlH > 0) body['ttlHours'] = ttlH
      const res = await authedFetch(`/docs/${encodeURIComponent(docId)}/links`,
        { method: 'POST', body: JSON.stringify(body) })
      if (!res.ok) { setShareErr(`link failed: ${res.status}`); return }
      const { token: g } = await res.json() as { token: string }
      await navigator.clipboard.writeText(
        `${location.origin}${location.pathname}?doc=${encodeURIComponent(docId)}&grant=${encodeURIComponent(g)}`)
      setShareErr(`${r} link copied${ttlH ? ` (${ttlH}h)` : ''}`)
      void loadLinks()
    } catch { setShareErr('link request failed') }
  }, [authedFetch, docId])
  const loadMembers = useCallback(async () => {
    try {
      const res = await authedFetch(`/docs/${encodeURIComponent(docId)}/members`)
      setMemberList(res.ok ? await res.json() as Record<string, string> : null)
    } catch { setMemberList(null) }
  }, [authedFetch, docId])
  const addMember = useCallback(async (login: string, r: string) => {
    const res = await authedFetch(`/docs/${encodeURIComponent(docId)}/members`,
      { method: 'POST', body: JSON.stringify({ login, role: r }) })
    setShareErr(res.ok ? `${login} added` :
      res.status === 400 ? 'no such login / bad role' : `add failed: ${res.status}`)
    if (res.ok) void loadMembers()
  }, [authedFetch, docId, loadMembers])
  // Active bearer links — invisible ones can't be revoked, so the
  // panel lists every live grant with copy + kill buttons.
  const [linkList, setLinkList] = useState<Record<string, string> | null>(null)
  const loadLinks = useCallback(async () => {
    try {
      const res = await authedFetch(`/docs/${encodeURIComponent(docId)}/links`)
      setLinkList(res.ok ? await res.json() as Record<string, string> : null)
    } catch { setLinkList(null) }
  }, [authedFetch, docId])
  const revokeLink = useCallback(async (t: string) => {
    const res = await authedFetch(
      `/docs/${encodeURIComponent(docId)}/links/${encodeURIComponent(t)}`,
      { method: 'DELETE' })
    setShareErr(res.ok ? 'link revoked' : `revoke failed: ${res.status}`)
    if (res.ok) void loadLinks()
  }, [authedFetch, docId, loadLinks])
  // Irreversible: wipes journal, meta, links, members AND blob bytes.
  // Live sockets lose rights on their next op (tombstone → null role).
  const destroyDoc = useCallback(async () => {
    if (!confirm(`Destroy ${docId} forever? No undo.`)) return
    const res = await authedFetch(
      `/docs/${encodeURIComponent(docId)}?hard=1`, { method: 'DELETE' })
    if (res.ok) {
      const q = new URLSearchParams(location.search)
      q.delete('doc'); q.delete('grant')
      location.search = q.toString()
    } else setShareErr(`destroy failed: ${res.status}`)
  }, [authedFetch, docId])
  const transferOwner = useCallback(async (login: string) => {
    if (!confirm(`Make ${login} the owner? You drop to admin.`)) return
    const res = await authedFetch(
      `/docs/${encodeURIComponent(docId)}/owner`,
      { method: 'POST', body: JSON.stringify({ login }) })
    if (res.ok) { setRole('admin'); void loadMembers() }
    else setShareErr(`transfer failed: ${res.status}`)
  }, [authedFetch, docId, loadMembers])
  // Doc comments — live deltas ride the hub 'comment' broadcast into
  // session.comments; REST GET fills the backlog on panel open.
  const [showComments, setShowComments] = useState(false)
  const [commentRows, setCommentRows] = useState<
    { id: string; a: string; t: string; ts: number }[]>([])
  const syncComments = useCallback(() => {
    const s = session()
    setCommentRows([...s.comments.entries()]
      .map(([id, c]) => ({ id, ...c }))
      .sort((x, y) => x.ts - y.ts))
  }, [])
  const loadComments = useCallback(async () => {
    const q = grant ? `?grant=${encodeURIComponent(grant)}` : ''
    try {
      const res = await authedFetch(
        `/docs/${encodeURIComponent(docId)}/comments${q}`)
      if (!res.ok) return
      const list = await res.json() as typeof commentRows
      const s = session()
      s.comments.clear()
      for (const c of list) s.comments.set(c.id, c)
      syncComments()
    } catch { /* empty panel on failure — non-fatal */ }
  }, [authedFetch, docId, grant, syncComments])
  const sendComment = useCallback(async (text: string) => {
    if (!text.trim()) return
    try { await session().addComment(text) }
    catch { setShareErr('comment rejected') }
  }, [])
  const delComment = useCallback(async (cid: string) => {
    try { await session().delComment(cid) } catch { /* vetoed */ }
  }, [])
  // T-27: doc name lives in doc:{id}:meta — rename is admin+.
  const [docName, setDocName] = useState<string | null>(null)
  const loadMeta = useCallback(async () => {
    try {
      const res = await authedFetch(`/docs/${encodeURIComponent(docId)}/meta`)
      if (res.ok) setDocName(
        (await res.json() as { name: string | null }).name)
    } catch { /* meta is cosmetic — a 403 just means no admin rights */ }
  }, [authedFetch, docId])
  const rename = useCallback(async (name: string) => {
    const res = await authedFetch(`/docs/${encodeURIComponent(docId)}`,
      { method: 'PATCH', body: JSON.stringify({ name }) })
    setShareErr(res.ok ? 'renamed' : `rename failed: ${res.status}`)
    if (res.ok) setDocName(name)
  }, [authedFetch, docId])
  const doAuth = useCallback(async (
    path: 'login' | 'register', l: string, p: string) => {
    try {
      const r = await fetch(`/auth/${path}`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: l, password: p }) })
      if (!r.ok) { setAuthErr(r.status === 409 ? 'login taken'
        : r.status === 401 ? 'wrong login or password'
        : 'login 2-32 [a-z0-9_-], pass >= 6'); return }
      const d = await r.json() as { token: string; login: string }
      localStorage.setItem('cc_token', d.token)
      localStorage.setItem('cc_login', d.login)
      setToken(d.token); setLogin(d.login); setAuthErr('')
    } catch { setAuthErr('auth request failed') }
  }, [])
  const logout = useCallback(async () => {
    await authedFetch('/auth/logout', { method: 'POST' }).catch(() => {})
    localStorage.removeItem('cc_token'); localStorage.removeItem('cc_login')
    setToken(null); setLogin(null)
  }, [authedFetch])
  // Server keeps this session, kills every other token — so the
  // UI doesn't log itself out but a leaked old session dies.
  const changePass = useCallback(async () => {
    const oldPw = prompt('current password')
    if (!oldPw) return
    const newPw = prompt('new password (min 6)')
    if (!newPw) return
    const res = await authedFetch('/auth/password',
      { method: 'POST', body: JSON.stringify({ old: oldPw, new: newPw }) })
    setAuthErr(res.ok ? 'password changed'
      : res.status === 403 ? 'wrong current password'
      : `change failed: ${res.status}`)
  }, [authedFetch])
  const [paintMode, setPaintMode] = useState<'fill' | 'stroke'>('fill')
  const pickFromLayers = useCallback((id: string) => {
    const ed = editor()
    ed.selected.clear(); ed.selected.add(id)
    const o = session().model.objects().find((x) => x.id === id)
    const b = o && boundsOf(o)
    if (b) rendererRef.current?.fitBounds(
      { x0: b.x0 - 40, y0: b.y0 - 40, x1: b.x1 + 40, y1: b.y1 + 40 })
    markDirty()
  }, [editor, markDirty])
  const showHistory = useCallback(async () => {
    if (hist !== null) { setHistory(null); return }
    try {
      const ops = await (await authedFetch(
        `/ops?doc=${encodeURIComponent(docId)}&n=50` +
        (grant ? `&grant=${encodeURIComponent(grant)}` : ''))).json()
      setHistory(ops)
    } catch { setHistory([]) }
  }, [hist, docId, authedFetch, grant])

  const connect = useCallback(async () => {
    setState('connecting')
    setError(null)
    try {
      const s = session()
      s.onChange = markDirty
      s.onPresence = markDirty
      s.onComments = syncComments
      await s.join(docId, clientId.current, '/hubs/document', token, grant)
      setRole(s.role)
      setState('joined')
      markDirty()
      void refreshDocs()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setState('error')
    }
  }, [markDirty, docId, refreshDocs, token, grant])

  /** T-19: hop to another doc on the same connection; ?doc= follows. */
  const switchDoc = useCallback(async (next: string) => {
    const id = next.trim()
    if (!id || id === docId) return
    setDocId(id)
    // Grant intentionally NOT carried: it's doc-scoped — leaking
    // doc A's bearer token into doc B URLs is worse than losing
    // it on switch (session.switchDoc still re-sends the real one).
    history.replaceState(null, '', `?doc=${encodeURIComponent(id)}`)
    await session().switchDoc(id)
    void refreshDocs()
  }, [docId, refreshDocs])

  useEffect(() => () => { void sessionRef.current?.stop() }, [])
  useEffect(() => {
    if (showShare && canManage)
      { void loadMembers(); void loadMeta(); void loadLinks() }
  }, [showShare, canManage, loadMembers, loadMeta, loadLinks])
  useEffect(() => {
    if (showComments && state === 'joined') void loadComments()
  }, [showComments, state, loadComments])

  // Tool hotkeys + Delete.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (editingRef.current) return // typing belongs to the overlay
      if (e.key === ' ') { spaceDown.current = true; return }
      // Esc closes the topmost panel before falling through to the
      // editor's deselect — standard "esc dismisses surface" rule.
      if (e.key === 'Escape' &&
          (showHelp || showLayers || hist !== null)) {
        setShowHelp(false); setShowLayers(false); setHistory(null)
        return
      }
      const map: Record<string, Tool> = {
        v: 'select', r: 'rect', e: 'ellipse', l: 'line', t: 'text', p: 'path',
      }
      if (map[e.key]) { editor().tool = map[e.key]!; setTool(map[e.key]!) }
      if (e.key === '1' || e.key === '!') {
        // zoom-to-fit: Shift+1 ('!') = selection, else whole doc
        const sel = editor().selected
        const objs = e.shiftKey && sel.size
          ? session().model.objects().filter((o) => sel.has(o.id))
          : session().model.objects()
        if (objs.length) {
          let b = boundsOf(objs[0]!)!
          for (const o of objs) {
            const ob = boundsOf(o)
            if (ob) b = { x0: Math.min(b.x0, ob.x0), y0: Math.min(b.y0, ob.y0),
                          x1: Math.max(b.x1, ob.x1), y1: Math.max(b.y1, ob.y1) }
          }
          rendererRef.current?.fitBounds(b)
        }
      }
      if (e.key === 'g') { // T-23: grid + snap toggle
        const ed = editor()
        ed.snap = !ed.snap
        if (rendererRef.current) {
          rendererRef.current.showGrid = ed.snap
          rendererRef.current.markDirty()
        }
      }
      if (e.key === 'm' && rendererRef.current) { // T-25: minimap
        rendererRef.current.showMinimap = !rendererRef.current.showMinimap
        rendererRef.current.markDirty()
      }
      if (e.key === '?') setShowHelp((h) => !h) // undiscoverable otherwise
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        const json = editor().copyJson()
        if (json) void navigator.clipboard?.writeText(json).catch(() => {})
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
        // Cut = copy + delete. key('Delete') rides the same
        // compensating-op undo path as the Delete key.
        const json = editor().copyJson()
        if (json) {
          void navigator.clipboard?.writeText(json).catch(() => {})
          editor().key('Delete')
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'v')
        void navigator.clipboard?.readText()
          // No cursor seen yet → paste falls back to the copy's own
          // spot +24 offset; (0,0) would dump it outside the view.
          .then((s) => editor().pasteJson(s,
            seenMouse.current ? lastPos.current : undefined))
          .catch(() => {}) // clipboard denied or not ours — no-op
      if (e.ctrlKey || e.metaKey) e.preventDefault() // Ctrl+D is ours, not bookmark
      editor().key(e.key, e.ctrlKey || e.metaKey, e.shiftKey, e.altKey)
    }
    const up = (e: KeyboardEvent) => { if (e.key === ' ') spaceDown.current = false }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
    // deps include panel states — the Esc check above reads them.
  }, [editor, showHelp, showLayers, hist])

  const stress = useCallback((n: number) => {
    if (n === 0) session().model.clearGhosts()
    else session().model.debugFill(n)
    markDirty()
  }, [markDirty])

  const world = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return rendererRef.current!.toWorld(
      e.clientX - rect.left, e.clientY - rect.top)
  }

  const panning = (e: React.MouseEvent<HTMLCanvasElement>) =>
    e.button === 1 || e.button === 2 || spaceDown.current

  return (
    <div className="shell">
      <header>
        <h1>CollabCanvas</h1>
        <span className={`pill ${state}`}>{state}</span>
        <button onClick={() => void connect()} disabled={state === 'connecting'}>
          Join {docId}
        </button>
        {login ? (
          <>
            <span className="pill" title="signed in">
              👤 {login}{role ? ` · ${role}` : ''}</span>
            <button className="tool" onClick={() => void changePass()}>
              pass</button>
            <button className="tool" onClick={() => void logout()}>
              logout</button>
          </>
        ) : (
          <>
            <input className="insp-input" style={{ width: 90 }}
              placeholder="login" id="auth-login" />
            <input className="insp-input" style={{ width: 90 }}
              placeholder="pass" type="password" id="auth-pass" />
            <button className="tool" onClick={() => void doAuth('login',
              field('auth-login')?.value ?? '',
              field('auth-pass')?.value ?? '')}>
              sign in</button>
            <button className="tool" onClick={() => void doAuth('register',
              field('auth-login')?.value ?? '',
              field('auth-pass')?.value ?? '')}>
              register</button>
          </>
        )}
        {authErr && <span className="pill error">{authErr}</span>}
        {/* Share/upload errors must be visible even with the
            share panel closed — e.g. a failed image upload. */}
        {shareErr && <span className="pill error">{shareErr}</span>}
        {state === 'joined' && (
          <>
            <select className="docpick" value={docId}
              onChange={(e) => void switchDoc(e.target.value)}>
              <option value={docId}>{docId}</option>
              {docList.filter((d) => d !== docId).map((d) =>
                <option key={d} value={d}>{d}</option>)}
            </select>
            <button className={showShare ? 'tool active' : 'tool'}
              onClick={() => setShowShare(!showShare)}>share</button>
            <button className={showComments ? 'tool active' : 'tool'}
              onClick={() => setShowComments(!showComments)}>chat</button>
            <button className="tool" title="remove this doc from the shared list"
              onClick={() => void (async () => {
                // T-32: delist only — journal survives; rejoining re-adds.
                await authedFetch(
                  `/docs/${encodeURIComponent(docId)}`, { method: 'DELETE' })
                void refreshDocs()
              })()}>unlist</button>
          </>
        )}
        {role !== 'viewer' && (<>
          {TOOLS.map((t) => (
            <button key={t}
              className={t === tool ? 'tool active' : 'tool'}
              onClick={() => { editor().tool = t; setTool(t) }}>
              {t}
            </button>
          ))}
          <input type="color" className="swatch" title="brush color"
            defaultValue="#3d5af1"
            onChange={(e) => editor().applyColor(e.target.value,
              paintMode === 'stroke')} />
          <button className={paintMode === 'stroke' ? 'tool active' : 'tool'}
            title="paint target: fill or stroke outline"
            onClick={() => setPaintMode(
              paintMode === 'stroke' ? 'fill' : 'stroke')}>
            {paintMode}</button>
          <button className="tool" title="no fill / no stroke (hollow)"
            onClick={() => editor().applyColor('none',
              paintMode === 'stroke')}>⊘</button>
          {/* T-36: image upload → blob → image object at view center. */}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif"
            id="img-upload" style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f || state !== 'joined') return
              void (async () => {
                // authedFetch keeps Bearer; the Content-Type
                // override replaces its json default.
                const res = await authedFetch(
                  `/docs/${encodeURIComponent(docId)}/blobs`
                    + (grant ? `?grant=${encodeURIComponent(grant)}` : ''),
                  { method: 'POST',
                    headers: { 'Content-Type': f.type }, body: f })
                if (!res.ok) { setShareErr(`upload: ${res.status}`); return }
                const { id } = await res.json() as { id: string }
                const v = rendererRef.current!.view
                const cv = canvasRef.current!
                const cx = (cv.clientWidth / 2 - v.x) / v.scale
                const cy = (cv.clientHeight / 2 - v.y) / v.scale
                const probe = new Image()
                probe.onload = () => editor().insertImage(
                  id, cx, cy, probe.naturalWidth, probe.naturalHeight)
                probe.onerror = () => editor().insertImage(id, cx, cy, 0, 0)
                probe.src = URL.createObjectURL(f)
              })()
            }} />
          <button className="tool" title="upload image"
            onClick={() => field('img-upload')?.click()}>
            img⭱</button>
        </>)}
        <button onClick={() => {
          // T-22: export — the canvas is already a bitmap; toDataURL
          // is the whole job. Remote cursors/handles are frame
          // artifacts and go into the png too (honest edge).
          const a = document.createElement('a')
          a.href = canvasRef.current!.toDataURL('image/png')
          a.download = `${docId}.png`
          a.click()
        }}>PNG</button>
        <button className={hist !== null ? 'tool active' : 'tool'}
          onClick={() => void showHistory()}>history</button>
        <button className={showLayers ? 'tool active' : 'tool'}
          onClick={() => setShowLayers(!showLayers)}>layers</button>
        <button onClick={() => stress(10_000)}>Stress 10k</button>
        <button onClick={() => stress(0)}>Clear</button>
        {stats && (
          <span className="stats">
            {stats.objects} obj · {stats.drawn} drawn · {stats.drawMs.toFixed(1)}ms ·
            {' '}{stats.fps.toFixed(0)}fps · seq {lastSeq}
          </span>
        )}
      </header>
      {error && <pre className="err">{error}</pre>}
      <div className="board-wrap">
        <canvas
          ref={canvasRef}
          className="board"
          onContextMenu={(e) => e.preventDefault()}
          onMouseDown={(e) => {
            if (panning(e)) panDrag.current = { x: e.clientX, y: e.clientY }
            else if (e.button === 0) {
              const w = world(e)
              editor().mouseDown(w.x, w.y, rendererRef.current!.view.scale,
                e.shiftKey)
            }
          }}
          onMouseUp={() => {
            panDrag.current = null
            editor().mouseUp()
            drainEditRequest()
            // Selection can change without a move — push it now so
            // remotes' colored frames don't lag a gesture behind.
            sessionRef.current?.sendPresence(lastPos.current.x,
              lastPos.current.y, color.current, [...editor().selected])
          }}
          onMouseLeave={() => { panDrag.current = null; editor().mouseUp() }}
          onDoubleClick={(e) => {
            const w = world(e)
            editor().dblClick(w.x, w.y)
            drainEditRequest()
          }}
          onMouseMove={(e) => {
            const r = rendererRef.current
            if (!r) return
            const w = world(e)
            if (panDrag.current) {
              r.pan(e.clientX - panDrag.current.x, e.clientY - panDrag.current.y)
              panDrag.current = { x: e.clientX, y: e.clientY }
            } else {
              editor().mouseMove(w.x, w.y, e.shiftKey,
                rendererRef.current!.view.scale, e.altKey)
            }
            lastPos.current = w; seenMouse.current = true
            sessionRef.current?.sendPresence(w.x, w.y, color.current,
              [...(editorRef.current?.selected ?? [])])
          }}
          onWheel={(e) => {
            const r = rendererRef.current
            if (!r) return
            const rect = e.currentTarget.getBoundingClientRect()
            r.zoomAt(e.clientX - rect.left, e.clientY - rect.top,
              Math.exp(-e.deltaY * 0.001))
          }}
        />
        {editing && <TextEditor id={editing.id} orig={editing.orig}
          session={session()} view={rendererRef.current!.view}
          onClose={closeEdit} />}
        {showLayers && state === 'joined' && (
          <aside className="history-panel layers-panel">
            <b>Layers · top first</b>
            {/* 10k stress objects would freeze the tab — same culling
                philosophy as the renderer: cap the list, show the rest
                as a count. */}
            {[...session().model.objects()].reverse().slice(0, 200)
              .map((o, i, rows) => (
              <div key={o.id}
                className={editor().selected.has(o.id)
                  ? 'hist-row sel' : 'hist-row'}
                onClick={() => pickFromLayers(o.id)}
                draggable
                // T-41: drag-drop reorders — the dropped object takes
                // the fractional z just under the row it lands on.
                onDragStart={(e) =>
                  e.dataTransfer.setData('text/plain', o.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault()
                  const dragId = e.dataTransfer.getData('text/plain')
                  if (!dragId || dragId === o.id) return
                  const below = rows[i + 1]
                  const z = below
                    ? FractionalIndex.between(below.z, o.z)
                    : FractionalIndex.before(o.z)
                  editor().reorderTo(dragId, z)
                }}
                style={o.props['locked']
                  ? { opacity: .55 } : undefined}>
                <span className="hist-type">{o.kind}</span>
                <span className="hist-who">
                  {o.props['locked'] ? '🔒 ' : ''}
                  {str(o.props, 'text') || o.id.slice(0, 8)}</span>
              </div>
            ))}
            {session().model.objects().length > 200 && (
              <div className="hist-row">
                <span className="hist-type">…</span>
                <span className="hist-who">
                  {session().model.objects().length - 200} more</span>
              </div>
            )}
          </aside>
        )}
        {/* T-26 stage 4: viewer mode hides mutating controls — cosmetic;
            session.submit() refuses ops for viewers server-side anyway. */}
        {state === 'joined' && role !== 'viewer' && <Inspector
          editor={editor()} model={session().model} />}
        {state === 'joined' && role === 'viewer' && (
          <div className="pill" style={{ position: 'absolute',
            left: 12, bottom: 12 }}>view only</div>
        )}
        {showShare && canManage && state === 'joined' && (
          <aside className="history-panel">
            <b>Share{docName ? ` · ${docName}` : ''}</b>
            <div className="hist-row" style={{ gap: 4 }}>
              <input className="insp-input" id="doc-rename"
                placeholder={docName ?? 'doc name'} style={{ width: 110 }} />
              <button className="tool" onClick={() => void rename(
                field('doc-rename')?.value ?? '')}>
                rename</button>
            </div>
            <button className="tool" onClick={() => void copyLink('viewer')}>
              copy view link</button>
            <button className="tool" onClick={() => void copyLink('editor')}>
              copy edit link</button>
            {/* Bearer links die on time when set — blank = forever.
                A leaked expiring link stops mattering by itself. */}
            <div className="hist-row" style={{ gap: 4 }}>
              <input className="insp-input" id="link-ttl" type="number"
                min={1} max={720} placeholder="exp h" style={{ width: 56 }}
                title="link expiry in hours (blank = never)" />
            </div>
            <div className="hist-row" style={{ gap: 4 }}>
              <input className="insp-input" id="share-login"
                placeholder="login" style={{ width: 80 }} />
              <select id="share-role" className="insp-input">
                <option value="editor">editor</option>
                <option value="viewer">viewer</option>
                {role === 'owner' && <option value="admin">admin</option>}
              </select>
              <button className="tool" onClick={() => void addMember(
                field('share-login')?.value ?? '',
                field<HTMLSelectElement>('share-role')?.value ?? 'editor')}>
                add</button>
            </div>
            {memberList && Object.entries(memberList).map(([l, r]) => (
              <div className="hist-row" key={l}>
                <span className="hist-who">{l}</span>
                <span className="hist-type">{r}</span>
                {role === 'owner' && r !== 'owner' && (
                  <button className="tool" title="make owner (you become admin)"
                    onClick={() => void transferOwner(l)}>own</button>
                )}
              </div>
            ))}
            {linkList && Object.keys(linkList).length > 0 && <b>Links</b>}
            {linkList && Object.entries(linkList).map(([t, r]) => (
              <div className="hist-row" key={t}>
                <span className="hist-who" title={t}>
                  {r} · {t.slice(0, 8)}…</span>
                <button className="tool" title="copy URL"
                  onClick={() => void navigator.clipboard.writeText(
                    `${location.origin}${location.pathname}?doc=${encodeURIComponent(docId)}&grant=${encodeURIComponent(t)}`)}>cp</button>
                <button className="tool" onClick={() => void revokeLink(t)}>
                  kill</button>
              </div>
            ))}
            {role === 'owner' && (
              <button className="tool" style={{ color: '#e08080' }}
                onClick={() => void destroyDoc()}>
                destroy doc</button>
            )}
          </aside>
        )}
        {showComments && state === 'joined' && (
          <aside className="history-panel">
            <b>Comments</b>
            {commentRows.map((c) => (
              <div className="hist-row" key={c.id}>
                <span className="hist-who">{c.a}</span>
                <span style={{ flex: 1 }}>{c.t}</span>
                {/* guests (author guest·xxx) can't delete their own —
                    server compares the stored author to your login */}
                {(c.a === login || canManage) && (
                  <button className="tool"
                    onClick={() => void delComment(c.id)}>×</button>
                )}
              </div>
            ))}
            {commentRows.length === 0 && <i>no comments</i>}
            {role !== 'viewer' && (
              <div className="hist-row" style={{ gap: 4 }}>
                <input className="insp-input" id="comment-new"
                  placeholder="say something…" style={{ flex: 1 }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    void sendComment(field('comment-new')?.value ?? '')
                    if (field('comment-new')) field('comment-new')!.value = ''
                  }} />
                <button className="tool" onClick={() => {
                  void sendComment(field('comment-new')?.value ?? '')
                  if (field('comment-new')) field('comment-new')!.value = ''
                }}>send</button>
              </div>
            )}
          </aside>
        )}
        {/* Empty-doc onboarding hint — a blank canvas otherwise
            gives no affordance. Hidden the moment anything exists. */}
        {state === 'joined' && !session().model.objectCount() && (
          <div className="empty-hint">
            {role === 'viewer'
              ? 'nothing here yet — you have view-only access'
              : <>pick a tool above — <b>r</b>ect, <b>t</b>ext, <b>p</b>ath…
                  press <b>?</b> for shortcuts</>}
          </div>
        )}
        {showHelp && (
          <aside className="history-panel help-panel">
            <b>Shortcuts</b>
            {([
              ['v/r/e/l/t/p', 'tools'], ['dblclick text', 'edit'],
              ['ctrl+g', 'group'], ['ctrl+shift+g', 'ungroup'],
              ['shift+click', 'multi-select'], ['drag marquee', 'select area'],
              ['8 handles', 'resize · shift=aspect alt=center'],
              ['top handle / shift+BR', 'rotate · shift=15°'], ['arrows', 'nudge · shift=10'], ['= -', 'font size'], ['alt+arrows / h v', 'align edges / centers'], ['alt+shift+h v', 'distribute'],
              ['ctrl+d', 'duplicate'], ['ctrl+c/x/v', 'copy/cut/paste'],
              ['ctrl+shift+l', 'lock/unlock'],
              ['ctrl+z/y', 'undo / redo'], ['del', 'delete'],
              ['[ ]', 'back / front'], ['ctrl+[ ]', 'step layer'],
              ['ctrl+a / esc', 'all / deselect'], ['g', 'grid+snap'],
              ['m', 'minimap'], ['1 / shift+1', 'zoom fit / selection'], ['space+drag', 'pan'],
              ['wheel', 'zoom'], ['?', 'this panel'],
            ] as const).map(([k, d]) => (
              <div key={k} className="hist-row">
                <span className="hist-seq">{k}</span>
                <span className="hist-who">{d}</span>
              </div>
            ))}
          </aside>
        )}
        {hist !== null && (
          <aside className="history-panel">
            <b>Recent ops · doc {docId}</b>
            {hist.length === 0 && <p>no ops in journal tail</p>}
            {[...hist].reverse().map((o) => (
              <div key={o.seq} className="hist-row">
                <span className="hist-seq">#{o.seq}</span>
                <span className="hist-type">{o.type}</span>
                <span className="hist-who">{o.clientId}</span>
              </div>
            ))}
          </aside>
        )}
      </div>
    </div>
  )
}
