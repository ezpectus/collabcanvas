// Wire contract mirroring src/CollabCanvas.Core/Protocol/Messages.cs.
// Keep field names camelCase — SignalR uses JSON case-insensitive
// binding on the server side.

export type OpType = 'Create' | 'Patch' | 'Delete' | 'Reorder'

export interface JoinDocumentRequest {
  docId: string
  clientId: string
  lastSeq: number
}

export interface JoinResult {
  docId: string
  lastSeq: number
  snapshot: unknown | null
  snapshotSeq: number
  ops: OpBroadcast[]
}

export interface OpBroadcast {
  docId: string
  seq: number
  clientId: string
  clientSeq: number
  type: OpType
  payload: unknown
}

export interface OpAck {
  clientSeq: number
  seq: number
  accepted: boolean
  reason?: string
}

export interface PresenceUpdate {
  docId: string
  clientId: string
  cursor: { x: number; y: number }
  selection: string[]
  color: string
  /** Server-owned login (T-26) — absent for guests. */
  name?: string
}

export interface PresenceBroadcast {
  clientId: string
  update: PresenceUpdate
}

export interface PresenceLeft {
  docId: string
  clientId: string
}
