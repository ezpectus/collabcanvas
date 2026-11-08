// SignalR session (T-8 client half): join → snapshot-or-tail → live
// op stream; reconnect re-joins with our lastSeq so the server sends
// exactly what we missed (T-5 contract). Op apply goes straight into
// DocModel — server ops and local optimistic ops share one path,
// because the model's LWW registers don't care about the source.

import * as signalR from '@microsoft/signalr'
import { DocModel, type SnapshotObject } from './model'
import type {
  JoinResult, OpAck, OpBroadcast, OpType, PresenceUpdate,
} from './protocol'

export class Session {
  readonly model = new DocModel()
  readonly cursors = new Map<string, PresenceUpdate>()
  private conn: signalR.HubConnection | null = null
  private clientSeq = 0
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
      .withAutomaticReconnect()
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

  /** (Re)join: server decides tail vs snapshot from our lastSeq. */
  private async rejoin(lastSeq = this.model.lastSeq): Promise<void> {
    const res = await this.conn!.invoke<JoinResult>('JoinDocument', {
      docId: this.docId,
      clientId: this.clientId,
      lastSeq,
    })
    if (res.snapshot)
      this.model.restore(res.snapshot as SnapshotObject[], res.snapshotSeq)
    for (const op of res.ops) this.model.apply(op)
    this.onChange?.()
  }

  async submit(type: OpType, payload: Record<string, unknown>): Promise<OpAck> {
    const ack = await this.conn!.invoke<OpAck>('SubmitOp', {
      docId: this.docId,
      clientId: this.clientId,
      clientSeq: ++this.clientSeq,
      type,
      payload,
    })
    return ack
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
