import { useCallback, useEffect, useRef, useState } from 'react'
import * as signalR from '@microsoft/signalr'
import type { JoinResult } from './protocol'

type ConnState = 'idle' | 'connecting' | 'joined' | 'error'

// T-2 shell: proves the wire end-to-end — SignalR negotiate, join, ack.
// The real canvas/editor lands in T-8/T-9; this panel just makes the
// plumbing visible.
export default function App() {
  const [state, setState] = useState<ConnState>('idle')
  const [join, setJoin] = useState<JoinResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hubRef = useRef<signalR.HubConnection | null>(null)
  const clientId = useRef(`web-${Math.random().toString(36).slice(2, 8)}`)

  const connect = useCallback(async () => {
    setState('connecting')
    setError(null)
    try {
      const conn = new signalR.HubConnectionBuilder()
        .withUrl('/hubs/document')
        .withAutomaticReconnect()
        .build()
      await conn.start()
      const result = await conn.invoke<JoinResult>('JoinDocument', {
        docId: 'demo',
        clientId: clientId.current,
        lastSeq: 0,
      })
      hubRef.current = conn
      setJoin(result)
      setState('joined')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setState('error')
    }
  }, [])

  useEffect(() => () => { void hubRef.current?.stop() }, [])

  return (
    <div className="shell">
      <header>
        <h1>CollabCanvas</h1>
        <span className={`pill ${state}`}>{state}</span>
      </header>
      <section className="panel">
        <button onClick={() => void connect()} disabled={state === 'connecting'}>
          Join demo document
        </button>
        {join && (
          <pre>{JSON.stringify(join, null, 2)}</pre>
        )}
        {error && <pre className="err">{error}</pre>}
        <p className="hint">
          Scaffold stage (T-2): join/leave + negotiate work; ops ack
          "not-implemented" until T-4. Canvas render lands in T-8.
        </p>
      </section>
      <canvas className="board" width={800} height={480} />
    </div>
  )
}
