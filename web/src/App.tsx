import { useCallback, useEffect, useRef, useState } from 'react'
import { Session } from './session'
import { Renderer, type FrameStats } from './renderer'
import { SceneIndex } from './quadtree'
import { Editor, type Tool } from './editor'
import { boundsOf } from './geometry'

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

export default function App() {
  const [state, setState] = useState<ConnState>('idle')
  const [stats, setStats] = useState<FrameStats | null>(null)
  const [lastSeq, setLastSeq] = useState(0)
  const [tool, setTool] = useState<Tool>('select')
  const [error, setError] = useState<string | null>(null)
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
    )
    rendererRef.current = r
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
      session().submit('Patch', { id: st.id, props: { text: value } })
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

  const connect = useCallback(async () => {
    setState('connecting')
    setError(null)
    try {
      const s = session()
      s.onChange = markDirty
      s.onPresence = markDirty
      await s.join('demo', clientId.current)
      setState('joined')
      markDirty()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setState('error')
    }
  }, [markDirty])

  useEffect(() => () => { void sessionRef.current?.stop() }, [])

  // Tool hotkeys + Delete.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (editingRef.current) return // typing belongs to the overlay
      if (e.key === ' ') { spaceDown.current = true; return }
      const map: Record<string, Tool> = {
        v: 'select', r: 'rect', e: 'ellipse', l: 'line', t: 'text', p: 'path',
      }
      if (map[e.key]) { editor().tool = map[e.key]!; setTool(map[e.key]!) }
      if (e.key === '1') { // zoom-to-fit — whole document in view
        const objs = session().model.objects()
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
      if (e.ctrlKey || e.metaKey) e.preventDefault() // Ctrl+D is ours, not bookmark
      editor().key(e.key, e.ctrlKey || e.metaKey)
    }
    const up = (e: KeyboardEvent) => { if (e.key === ' ') spaceDown.current = false }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [editor])

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
          Join demo
        </button>
        {TOOLS.map((t) => (
          <button key={t}
            className={t === tool ? 'tool active' : 'tool'}
            onClick={() => { editor().tool = t; setTool(t) }}>
            {t}
          </button>
        ))}
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
              editor().mouseMove(w.x, w.y, e.shiftKey)
            }
            lastPos.current = w
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
      </div>
    </div>
  )
}
