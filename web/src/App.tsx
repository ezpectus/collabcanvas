import { useCallback, useEffect, useRef, useState } from 'react'
import { Session } from './session'
import { Renderer, type FrameStats } from './renderer'
import { SceneIndex } from './quadtree'
import { Editor, type Tool } from './editor'
import { boundsOf, num, str } from './geometry'
import type { DocModel } from './model'

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

  const refreshDocs = useCallback(async () => {
    try { setDocList(await (await fetch('/docs')).json()) }
    catch { /* discovery degrades, doc still works */ }
  }, [])

  // T-24: audit view of the journal tail — who did what, not a time
  // machine (hist deeper than MAXLEN doesn't exist).
  const [hist, setHistory] = useState<
    { seq: number; type: string; clientId: string }[] | null>(null)

  // T-28: layers panel — the find-your-object surface. At 10k objects
  // canvas clicking alone can't locate things; z-sorted list can.
  const [showLayers, setShowLayers] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
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
      const ops = await (await fetch(
        `/ops?doc=${encodeURIComponent(docId)}&n=50`)).json()
      setHistory(ops)
    } catch { setHistory([]) }
  }, [hist, docId])

  const connect = useCallback(async () => {
    setState('connecting')
    setError(null)
    try {
      const s = session()
      s.onChange = markDirty
      s.onPresence = markDirty
      await s.join(docId, clientId.current)
      setState('joined')
      markDirty()
      void refreshDocs()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setState('error')
    }
  }, [markDirty, docId, refreshDocs])

  /** T-19: hop to another doc on the same connection; ?doc= follows. */
  const switchDoc = useCallback(async (next: string) => {
    const id = next.trim()
    if (!id || id === docId) return
    setDocId(id)
    history.replaceState(null, '', `?doc=${encodeURIComponent(id)}`)
    await session().switchDoc(id)
    void refreshDocs()
  }, [docId, refreshDocs])

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
          Join {docId}
        </button>
        {state === 'joined' && (
          <>
            <select className="docpick" value={docId}
              onChange={(e) => void switchDoc(e.target.value)}>
              <option value={docId}>{docId}</option>
              {docList.filter((d) => d !== docId).map((d) =>
                <option key={d} value={d}>{d}</option>)}
            </select>
            <button className="tool" onClick={() =>
              void navigator.clipboard.writeText(
                `${location.origin}${location.pathname}?doc=${encodeURIComponent(docId)}`)
            }>share</button>
            <button className="tool" title="remove this doc from the shared list"
              onClick={() => void (async () => {
                // T-32: delist only — journal survives; rejoining re-adds.
                await fetch(`/docs/${encodeURIComponent(docId)}`, { method: 'DELETE' })
                void refreshDocs()
              })()}>unlist</button>
          </>
        )}
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
        {showLayers && state === 'joined' && (
          <aside className="history-panel layers-panel">
            <b>Layers · top first</b>
            {[...session().model.objects()].reverse().map((o) => (
              <div key={o.id}
                className={editor().selected.has(o.id)
                  ? 'hist-row sel' : 'hist-row'}
                onClick={() => pickFromLayers(o.id)}
                style={o.props['locked']
                  ? { opacity: .55 } : undefined}>
                <span className="hist-type">{o.kind}</span>
                <span className="hist-who">
                  {o.props['locked'] ? '🔒 ' : ''}
                  {str(o.props, 'text') || o.id.slice(0, 8)}</span>
              </div>
            ))}
          </aside>
        )}
        {state === 'joined' && <Inspector editor={editor()}
          model={session().model} />}
        {showHelp && (
          <aside className="history-panel help-panel">
            <b>Shortcuts</b>
            {([
              ['v/r/e/l/t/p', 'tools'], ['dblclick text', 'edit'],
              ['shift+click', 'multi-select'], ['drag marquee', 'select area'],
              ['8 handles', 'resize · shift=aspect alt=center'],
              ['top handle / shift+BR', 'rotate · shift=15°'], ['arrows', 'nudge · shift=10'], ['= -', 'font size'], ['alt+arrows / h v', 'align edges / centers'], ['alt+shift+h v', 'distribute'],
              ['ctrl+d', 'duplicate'], ['ctrl+shift+l', 'lock/unlock'],
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
