import { useCallback, useEffect, useRef, useState } from 'react'
import { Session } from './session'
import { Renderer, type FrameStats } from './renderer'
import { FractionalIndex } from './fractionalIndex'

type ConnState = 'idle' | 'connecting' | 'joined' | 'error'

const COLORS = ['#e57373', '#81c784', '#64b5f6', '#ffb74d', '#ba68c8', '#4db6ac']

// T-8: real render path — DocModel → Canvas via rAF+dirty loop,
// viewport pan/zoom, presence cursors. Editing tools land in T-9;
// "Spawn rect" exists only to prove the live op path end-to-end.
export default function App() {
  const [state, setState] = useState<ConnState>('idle')
  const [stats, setStats] = useState<FrameStats | null>(null)
  const [lastSeq, setLastSeq] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sessionRef = useRef<Session | null>(null)
  const rendererRef = useRef<Renderer | null>(null)
  const clientId = useRef(`web-${Math.random().toString(36).slice(2, 8)}`)
  const color = useRef(COLORS[Math.floor(Math.random() * COLORS.length)]!)
  const drag = useRef<{ x: number; y: number } | null>(null)
  const statTick = useRef(0)

  const session = (): Session => (sessionRef.current ??= new Session())

  // Mount the render loop once — React never touches the canvas again.
  useEffect(() => {
    const r = new Renderer(
      canvasRef.current!,
      () => session().model.objects(),
      () => session().cursors.values(),
    )
    rendererRef.current = r
    // Stats hit React state at ~10Hz — a 60fps onFrame would be a
    // re-render storm; the canvas itself never re-renders.
    r.onFrame = (s) => {
      if (++statTick.current % 6 === 0) setStats({ ...s })
    }
    r.start()
    return () => r.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const markDirty = useCallback(() => {
    rendererRef.current?.markDirty()
    setLastSeq(session().model.lastSeq)
  }, [])

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

  // Spawn one real op — proves the full path mouse→server→journal→echo.
  const spawnRect = useCallback(async () => {
    const s = sessionRef.current
    if (!s || state !== 'joined') return
    const id = `o-${Math.random().toString(36).slice(2, 8)}`
    const top = s.model.objects().at(-1)?.z
    await s.submit('Create', {
      id, kind: 'rect',
      z: top ? FractionalIndex.after(top) : FractionalIndex.first(),
      props: {
        x: Math.random() * 700, y: Math.random() * 400,
        w: 60 + Math.random() * 80, h: 40 + Math.random() * 60,
        fill: color.current,
      },
    })
  }, [state])

  const stress = useCallback((n: number) => {
    if (n === 0) session().model.clearGhosts()
    else session().model.debugFill(n)
    markDirty()
  }, [markDirty])

  return (
    <div className="shell">
      <header>
        <h1>CollabCanvas</h1>
        <span className={`pill ${state}`}>{state}</span>
        <button onClick={() => void connect()} disabled={state === 'connecting'}>
          Join demo
        </button>
        <button onClick={() => void spawnRect()} disabled={state !== 'joined'}>
          Spawn rect
        </button>
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
          onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY } }}
          onMouseUp={() => { drag.current = null }}
          onMouseLeave={() => { drag.current = null }}
          onMouseMove={(e) => {
            const r = rendererRef.current
            if (!r) return
            const rect = e.currentTarget.getBoundingClientRect()
            const cx = e.clientX - rect.left
            const cy = e.clientY - rect.top
            if (drag.current) {
              r.pan(e.clientX - drag.current.x, e.clientY - drag.current.y)
              drag.current = { x: e.clientX, y: e.clientY }
            }
            const w = r.toWorld(cx, cy)
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
