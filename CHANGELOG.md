# Changelog — коммиты → файлы → таски

Карта «коммит → файлы → таск» (та же конвенция, что в Notification
Engine). Закрытые таски — `docs/done-log.md`.

Легенда: **[D]** — Devin писал код/доки · **[docs]** — документы.
Зоны «юзер руками» нет — юзер ревьюит.

---

## 2026-11-08 — T-12 полировка: path + presence + eviction [D]

- `web/src/editor.ts` — инструмент `path`: локальный create/patch
  в драге, один Create на mouseup, local-delete на отмене;
  отброс точек <1.5wu
- `IRoomTransport` — `PublishPresenceAsync`/`OnPresence` (Core +
  Local); `RedisRoomTransport` — канал `doc:{id}:pres`, fail-open
- `DocumentHub.Presence` → транспорт; `OpRouter` релеирует
  presence в группы (cross-instance)
- `Room.LastActivity`, `RoomManager.EvictIdle(10min)` —
  вызов из PresenceSweeper'а; eviction-test в `PresenceTests`
- `architecture.md` §22 + UPD §21.6, tasks T-12, PLAN +3

## 2026-11-08 — T-11 README + демо + perf [docs]

- `README.md` (EN) — картинка архитектуры, модель, запуск,
  what's proven / honest limitations
- `docs/guides/demo.md` — 4 акта демо + gate-вопросы
- tasks T-11 → `review` (+ perf-pass отчёт в тикете)

## 2026-11-08 — T-10 scale-out + хаос [D]

- `Core/Room/IRoomTransport.cs` — контракт owner/inbox/outbox +
  `LocalRoomTransport` (single-instance/тесты)
- `Api/Journal/RedisRoomTransport.cs` — claim `doc:{id}:owner`
  (SET NX, TTL 15с, renewal 5с), pub/sub `doc:{id}:in`/`:out`,
  fail-open на локальное владение
- `Api/Presence/OpRouter.cs` — inbox→Submit→outbox, outbox→группы
  (singleton; hub transient)
- `DocumentHub` — owner/non-owner ветки submit (ack `forwarded`),
  join из журнала на не-владельце
- `session.ts` — reconnect backoff exp × full jitter
- `ChaosTests` (3 шт): shuffle+dup → конвергенция, kill-mid-stream
  → честный durable-prefix, reconnect-storm → идентичные хвосты
- `docs/diagrams/mmd/scaleout.mmd`, `architecture.md` §21,
  tasks T-10 → `review`, PLAN +4

## 2026-11-08 — T-9 фронт: редактирование + QuadTree [D]

- `web/src/geometry.ts` — общий BBox/boundsOf (вынос из renderer)
- `web/src/quadtree.ts` — QuadTree cap8/depth10 + `SceneIndex`
  (rebuild по model.version, visibleIn z-sorted, hitTest topmost)
- `web/src/editor.ts` — инструменты select/move/resize/create/
  delete, драг с throttle 80мс + flush на mouseup
- `web/src/session.ts` — оптимистичный apply (temp-seq `lastSeq+ε`,
  cap 0.9995), pending → rebase+resubmit на rejoin, `applyLocal`
- `web/src/model.ts` — регистры вложенные по objId (O(n²) → O(n)),
  version-counter, lastSeq только по целым seq
- `Core/Model/Document.cs` — та же O(n²)-починка: регистры
  `objId→prop→(v,seq)` вместо flat `((id,prop)→…)`
- `renderer.ts` — culling через SceneIndex, selection-хайлайт
- `App.tsx` — тулбар, hotkeys (v/r/e/l/t), Space/middle-drag pan
- `docs/diagrams/mmd/client-render.mmd` (обновлена),
  `architecture.md` §20, tasks T-9 → `review`, PLAN +4

## 2026-11-08 — T-8 фронт: рендер [D]

- `web/src/model.ts` — DocModel: TS-зеркало LWW (regs/life, apply,
  restore со snapshot, objects() сортировка (z,id)), `debugFill`
  ghosts для стресса
- `web/src/session.ts` — join/rejoin (lastSeq → tail/snapshot),
  op/presence/presence-left/presence-state хендлеры, submit,
  presence-throttle
- `web/src/renderer.ts` — rAF по dirty, viewport pan/zoom с якорем,
  bbox-culling, draw 6 типов, dpr, remote cursors, FrameStats EMA
- `web/src/fractionalIndex.ts` — порт Between/First/After/Before
- `App.tsx` — монтаж рендерера, join/spawn/stress UI, stats ~10Гц
- `Api/Program.cs` — `JsonStringEnumConverter` (OpType строкой)
- `docs/diagrams/mmd/client-render.mmd`, `architecture.md` §19,
  tasks T-8 → `review`, PLAN +4

## 2026-11-08 — T-7 presence [D]

- `Core/Presence/PresenceTracker.cs` — per-client замещение,
  TTL-истечение, rate-limit фанаута (now снаружи — тестируемо)
- `Api/Presence/PresenceSweeper.cs` — hosted service, 2с тик,
  `presence-left` в группы
- `Room.Presence`, `RoomManager` — connection tracking
  (disconnect → мгновенный уход курсора)
- `DocumentHub` — presence через трекер, `presence-state` снэпшот
  на join, `OnDisconnectedAsync`
- `PresenceTests` (5 шт): замещение, rate-limit+TTL, expiry,
  heartbeat-слайдинг, disconnect без TTL
- `docs/diagrams/mmd/presence.mmd`, `architecture.md` §18,
  tasks T-7 → `review`, PLAN +3

## 2026-11-08 — T-6 fractional indexing [D]

- `Core/Model/FractionalIndex.cs` — `Between/First/After/Before`
  на base-62 строках, инвариант trailing-zero
- `FractionalIndexTests` (6 шт): порядок, края, детерминизм,
  500 вставок без исчерпания, 200 случайных вставок → sort order,
  невалидные входы
- `docs/diagrams/mmd/z-order.mmd`, `architecture.md` §17,
  tasks T-6 → `review`, PLAN +1

## 2026-11-08 — T-5 журнал + снапшоты + recovery [D]

- `Core/Journal/IOpJournal.cs` — sync-контракт + `InMemoryOpJournal`
  (с maxLen для тестов урезания) + фабрики
- `Api/Journal/RedisOpJournal.cs` — Stream `doc:{id}:ops`
  (MAXLEN ~10k) + `doc:{id}:snap`, fail-open деградация
- `Room.cs` — recovery в конструкторе (snapshot → replay → rebuild
  dedup), snapshot каждые 100 ops, join-ветки tail/snapshot,
  `_journal` List → словарь seq→op
- `Document.Restore` — rehydrate регистров на snapSeq;
  `Snapshot()` Props → `SortedDictionary` (был массив {Key,Value} —
  Restore падал)
- `PersistenceTests` (6 шт): replay, snapshot+tail, dedup после
  рестарта, join ниже базы/в будущем, урезанный журнал + снапшот
- `docs/diagrams/mmd/recovery.mmd`, `architecture.md` §16,
  tasks T-5 → `review`, PLAN +6

## 2026-11-08 — T-4 комната + seq [D]

- `Core/Room/Room.cs` + `RoomManager` — dedup/seq/apply/journal
  под локом, `_ackIndex` для ретраев
- `Hubs/DocumentHub.cs` — адаптер на реальный Room (join→ops-since,
  submit→broadcast+ack), broadcast включая автора
- `RoomTests` (5 шт): seq-порядок, retry-dedup, join catch-up,
  изоляция комнат, gapless seq под Parallel.For
- `docs/diagrams/mmd/seq-flow.mmd`, `architecture.md` §15,
  tasks T-4 → `review`, PLAN +3

## 2026-11-08 — T-3 модель + apply [D]

- `60f46cb` — `Core/Model/Document.cs` (LWW-регистры, createSeq
  vs deleteSeq, order-agnostic apply), `DocumentApplyTests` (6 шт),
  `Program.cs` abortConnect=false (тесты герметичны),
  `docs/diagrams/mmd/doc-model.mmd`
- `1b89c5f` — `architecture.md` §14, `tasks.md` T-3 → `review`,
  `PLAN.md` +3 записи

## 2026-11-08 — T-2 скелет решения [D]

- `eeb657b` — `CollabCanvas.sln`, `src/CollabCanvas.Core`
  (протокол: Messages.cs), `src/CollabCanvas.Api` (Program.cs,
  DocumentHub stub, Dockerfile), `tests/` (SkeletonTests 3/3),
  `web/` (Vite+React strict-TS, nginx, Dockerfile),
  `docker-compose.yml`, `.github/workflows/ci.yml`,
  `docs/diagrams/mmd/system.mmd`, `AGENTS.md` (правило диаграмм)
- `3605422` — `.gitignore`: `*.tsbuildinfo` (build-артефакты из
  первого коммита)
- `tasks.md` — T-2 → `review` (gate-вопросы для юзера)
- `PLAN.md` — +5 записей журнала (Core/Api split, честный
  not-implemented, health-degraded, порты, пин версий)

## 2026-11-07 — скелет + T-1 [docs]

- `606c726` — `docs/architecture.md`: требования, sync-модель
  (упрощённый CRDT по мотивам Figma), op-протокол, комната,
  реконнект, presence, журнал+снапшоты, 10 дизайн-развилок,
  карта отказов, честные риски, gate-вопросы §13 [docs]
- `53f6bda` — скелет проекта: AGENTS.md (перевёрнутые роли),
  tasks.md (11 тикетов), review_checklists, PLAN с 5 решениями [docs]
