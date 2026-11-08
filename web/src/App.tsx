import { useCallback, useEffect, useRef, useState } from 'react'
import { Session } from './session'
import { Renderer, type FrameStats } from './renderer'
import { SceneIndex } from './quadtree'
import { Editor, type Tool } from './editor'

type ConnState = 'idle' | 'connecting' | 'joined' | 'error'

const COLORS = ['#e57373', '#81c784', '#64b5f6', '#ffb74d', '#ba68c8', '#4db6ac']
const TOOLS: Tool[] = ['select', 'rect', 'ellipse', 'line', 'text']

// T-9: editing tools + optimistic apply. Pan lives on middle/right
// drag or Space+drag — left drag belongs to the active tool.
export default function App() {
  const [state, setState] = useState<ConnState>('idle')
  const [stats, setStats] = useState<FrameStats | null>(null)
  const [lastSeq, setLastSeq] = useState(0)
  const [tool, setTool] = useState<Tool>('select')
  const [error, setError] = useState<string | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sessionRef = useRef<Session | null>(null)
  const rendererRef = useRef<Renderer | null>(null)
  const indexRef = useRef(new SceneIndex())
  const editorRef = useRef<Editor | null>(null)
  const clientId = useRef(`web-${Math.random().toString(36).slice(2, 8)}`)
  const color = useRef(COLORS[Math.floor(Math.random() * COLORS.length)]!)
  const panDrag = useRef<{ x: number; y: number } | null>(null)
  const spaceDown = useRef(false)
  const statTick = useRef(0)

  const session = (): Session => (sessionRef.current ??= new Session())

  useEffect(() => {
    const r = new Renderer(
      canvasRef.current!,
      session().model,
      indexRef.current,
      () => session().cursors.values(),
      () => editorRef.current?.selectionBox() ?? null,
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
      if (e.key === ' ') { spaceDown.current = true; return }
      const map: Record<string, Tool> = {
        v: 'select', r: 'rect', e: 'ellipse', l: 'line', t: 'text',
      }
      if (map[e.key]) { editor().tool = map[e.key]!; setTool(map[e.key]!) }
      editor().key(e.key)
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
              editor().mouseDown(w.x, w.y, rendererRef.current!.view.scale)
            }
          }}
          onMouseUp={() => { panDrag.current = null; editor().mouseUp() }}
          onMouseLeave={() => { panDrag.current = null; editor().mouseUp() }}
          onMouseMove={(e) => {
            const r = rendererRef.current
            if (!r) return
            const w = world(e)
            if (panDrag.current) {
              r.pan(e.clientX - panDrag.current.x, e.clientY - panDrag.current.y)
              panDrag.current = { x: e.clientX, y: e.clientY }
            } else {
              editor().mouseMove(w.x, w.y)
            }
            sessionRef.current?.sendPresence(w.x, w.y, color.current)
          }}
          onWheel={(e) => {
            const r = rendererRef.current
            if (!r) return
            const rect = e.currentTarget.getBoundingClientRect()
            r.zoomAt(e.clientX - rect.left, e.clientY - rect.top,
              Math.exp(-e.deltaY * 0.001))
          }}
        />
      </div>
    </div>
  )
}
