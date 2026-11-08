// SignalR session (T-8 join, T-9 optimistic editing): join →
// snapshot-or-tail → live op stream; reconnect re-joins with lastSeq.
//
// Optimistic apply: a local op lands in DocModel IMMEDIATELY with a
// fractional temp seq (lastSeq + ε). Every real server seq is an int
// above it, so:
//   - a remote op always beats a pending optimistic write,
//   - our own echo rewrites the temp registers at the real seq.
// No rollback needed — LWW converges, there is no "wrong" temp state
// to undo, only a lower-priority one.
//
// Rebase: ops still pending at reconnect are replayed over the fresh
// server state as NEW submits (§7 strategy) — dedup by clientSeq makes
// already-landed ones no-ops.

import * as signalR from '@microsoft/signalr'
import { DocModel, type SnapshotObject } from './model'
import type {
  JoinResult, OpAck, OpBroadcast, OpType, PresenceUpdate,
} from './protocol'

interface PendingOp { type: OpType; payload: Record<string, unknown> }

export class Session {
  readonly model = new DocModel()
  readonly cursors = new Map<string, PresenceUpdate>()
  private conn: signalR.HubConnection | null = null
  private clientSeq = 0
  private optSeq = 0 // fractional temp seq for optimistic applies
  private readonly pending = new Map<number, PendingOp>()
  private docId = ''
  private clientId = ''
  private lastPresence = 0

  /** Fired after any state change worth a redraw. */
  onChange: (() => void) | null = null
  onPresence: (() => void) | null = null

  async join(docId: string, clientId: string, url = '/hubs/document'): Promise<void> {
    this.docId = docId
    this.clientId = clientId
    const conn = new signalR.HubConnectionBuilder()
      .withUrl(url)
      // Reconnect storm handling (T-10): exp backoff + full jitter —
      // a server restart drops ALL clients at once; synchronized
      // retries would stampede it back down.
      .withAutomaticReconnect({
        nextRetryDelayInMilliseconds: (ctx) =>
          Math.random() * Math.min(30_000, 1000 * 2 ** ctx.previousRetryCount),
      })
      .build()

    conn.on('op', (op: OpBroadcast) => {
      this.model.apply(op) // LWW makes echo/dup/reorder harmless
      this.onChange?.()
    })
    conn.on('presence-state', (s: Record<string, PresenceUpdate>) => {
      for (const id in s) if (id !== this.clientId) this.cursors.set(id, s[id]!)
      this.onPresence?.()
    })
    conn.on('presence', (b: { clientId: string; update: PresenceUpdate }) => {
      if (b.clientId !== this.clientId) this.cursors.set(b.clientId, b.update)
      this.onPresence?.()
    })
    conn.on('presence-left', (l: { docId: string; clientId: string }) => {
      this.cursors.delete(l.clientId)
      this.onPresence?.()
    })
    conn.onreconnected(() => { void this.rejoin() })

    await conn.start()
    this.conn = conn
    await this.rejoin(0)
  }

  /** (Re)join: server decides tail vs snapshot from our lastSeq; then
   * unacked optimistic ops are rebased on top (re-submitted — server
   * dedup absorbs the ones that did land). */
  private async rejoin(lastSeq = this.model.lastSeq): Promise<void> {
    const res = await this.conn!.invoke<JoinResult>('JoinDocument', {
      docId: this.docId,
      clientId: this.clientId,
      lastSeq,
    })
    if (res.snapshot)
      this.model.restore(res.snapshot as SnapshotObject[], res.snapshotSeq)
    for (const op of res.ops) this.model.apply(op)

    for (const [cs, p] of this.pending) {
      this.applyOptimistic(cs, p.type, p.payload)
      void this.conn!.invoke<OpAck>('SubmitOp', this.wire(cs, p))
        .then(() => this.pending.delete(cs))
        .catch(() => {}) // still pending — next reconnect retries
    }
    this.onChange?.()
  }

  /** Optimistic apply + submit. Local state updates synchronously —
   * zero-latency feel; the server seq arrives with the echo. */
  submit(type: OpType, payload: Record<string, unknown>): void {
    const cs = ++this.clientSeq
    this.pending.set(cs, { type, payload })
    this.applyOptimistic(cs, type, payload)
    this.onChange?.()
    if (!this.conn) return // offline — rebase on reconnect
    void this.conn.invoke<OpAck>('SubmitOp', this.wire(cs, { type, payload }))
      .then(() => this.pending.delete(cs))
      .catch(() => {}) // stays pending → resent after rejoin
  }

  /** Local-only optimistic apply — no wire, no pending. For
   * between-submit drag frames: the next real Patch overwrites
   * these registers anyway (fractional seqs beat older fractionals). */
  applyLocal(type: OpType, payload: Record<string, unknown>): void {
    this.applyOptimistic(0, type, payload)
  }

  private applyOptimistic(cs: number, type: OpType,
    payload: Record<string, unknown>): void {
    // Fractional seq: strictly above lastSeq so the user sees their own
    // edit, strictly below ANY future server seq so truth wins on echo.
    // Capped below the next integer — a temp that reaches N.0 would
    // falsely bump lastSeq AND tie-beat the real op with seq N.
    this.optSeq = Math.min(
      Math.max(this.optSeq + 0.001, this.model.lastSeq + 0.001),
      this.model.lastSeq + 0.9995)
    this.model.apply({
      docId: this.docId,
      seq: this.optSeq,
      clientId: this.clientId,
      clientSeq: cs,
      type,
      payload,
    })
  }

  private wire(cs: number, p: PendingOp) {
    return {
      docId: this.docId,
      clientId: this.clientId,
      clientSeq: cs,
      type: p.type,
      payload: p.payload,
    }
  }

  /** Cursor position, throttled to ~20/s — the server additionally
   * rate-limits fanout (T-7), so this is politeness, not safety. */
  sendPresence(x: number, y: number, color: string): void {
    const now = performance.now()
    if (!this.conn || now - this.lastPresence < 50) return
    this.lastPresence = now
    void this.conn.invoke('Presence', {
      docId: this.docId,
      clientId: this.clientId,
      cursor: { x, y },
      selection: [],
      color,
    })
  }

  async stop(): Promise<void> { await this.conn?.stop() }
}
