# CollabCanvas

Real-time collaborative canvas — a Figma-style multiplayer
whiteboard. Multiple users edit the same document simultaneously:
shapes, text, freehand, images, layers; live cursors and presence;
reconnect-safe sync.

**Sync model:** simplified CRDT over a central server — LWW
registers per object property, server-assigned sequencing,
op journal + snapshots for durability and catch-up, fractional
indexing for ordering. Presence is ephemeral (heartbeat + TTL),
separate from the persistent op stream.

**Stack:** ASP.NET Core + SignalR · Redis · React + TypeScript +
Canvas API · docker-compose.

**Status:** scaffold — see `docs/tasks.md` for the pipeline and
`docs/architecture.md` (T-1, pending) for the design.
