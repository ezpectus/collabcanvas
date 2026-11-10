## 2026-11-10 (продолжение) — T-26..T-34 + bugfix pass [D]

- T-27: draggable line endpoints + arrow nudge (a175bd0); esc/ctrl+a (904c81d)
- T-28: layers panel — z-sorted, click selects+zooms (9ee3c9d)
- z-step ctrl+bracket single (15d7cce); help overlay ? (466f072)
- T-29 hit-test: stroke-distance line/path (aa32ef6), quad для rot (8589c57)
- fontSize +/- (c574d4f); shift+marquee аддитив (5842c80)
- T-32: DELETE /docs/{id} delist + unlist btn (a578740)
- Esc cancel жеста (55641e2) + revert только gesture-ключей (5220693)
- T-30 alignment guides (9a8b8bc); roadmap resync (30c8e91)
- T-33 align+distribute (d8511bf, 1ba0c3c)
- bot покрывает /ops + DELETE, сам делистит doc (9f2fe32)
- T-34 group resize union-box (fec4b74); shift+1 zoom-selection (6eb452b)
- T-35 group rotate shift+BR (3b6b0e3); tasks T-33 fix (dce3433);
  changelog drift T-26..T-34 (b8788f8); roadmap sync (30c8e91)
- T-36 rotate handle (bf4c60b + syntax-fix 1d79184 — первый коммит
  собирался сломанным, честно отмечено); alt-center resize (e6fb51c)
- T-37 inspector panel x/y/w/h/rot (5374e42); inspector stale-input
  + fontSize fix (975bb48); T-38 object locking (646de8e);
  T-36/T-37 ticket+ledger docs (1600bf4)

## 2026-11-10 (tiếp) — T-23/24/25 [D]
- T-23: G snap-to-grid, grid adaptive density, path dùng brush
- T-24: IOpJournal.Tail + GET /ops + history panel (audit, ko time-travel)
- T-25: M minimap — dots + viewport rect, docBounds cached per version
# Changelog — коммиты → файлы → таски

Карта «коммит → файлы → таск» (та же конвенция, что в Notification
Engine). Закрытые таски — `docs/done-log.md`.

Легенда: **[D]** — Devin писал код/доки · **[docs]** — документы.
Зоны «юзер руками» нет — юзер ревьюит.

---

## 2026-11-10 — T-16..T-20 финиш бэклога [D]

- T-16 verify: `geometry.computeResize` (pure) + `resize.test.mjs`
  (9/9 — anchors pixel-fixed incl rot90, aspect, clamp)
- T-18: selection в presence-проводе; рамки чужого выделения
  цветом юзера; quadOf → geometry; bot +1 сценарий (18/18)
- T-17: undo/redo compensating ops — инверсии до apply, Ctrl+Z/Y;
  gesture = одна запись; null для отсутствовавших ключей
- T-19: `docs` Set на join, `GET /docs`, `?doc=` + share + picker,
  `Session.switchDoc`, `model.reset`
- T-20: `tests/perf.mjs` — реальные цифры (10k/50k index+cull,
  op RTT p50=1.1ms) → README; tsc-emit хак без новых deps
- Диск C: 82.4GB free (−5GB за 10 дней), факт в AGENTS.md

## 2026-11-09 — T-16 WIP + план на утро [D+docs]

- `web/src/editor.ts` — HANDLE_DIRS (8 шт), `handlePoints`, дельта
  в осях объекта, якорь противоположной стороны, aspect-lock
- `web/src/renderer.ts` — отрисовка всех 8 хендлов
- `web/src/App.tsx` — getHandles в Renderer, shift → mouseMove
- tasks T-16 → `review` (live-проверка отложена на утро)

## 2026-11-09 — T-15 + e2e-бот + validator-fix [D]

- `web/src/App.tsx` — TextEditor overlay (dblclick/click-place →
  textarea; applyLocal на keystroke, Patch на commit; Esc-откат)
- `web/src/editor.ts` — `wantEdit`/`takeEditRequest`, `dblClick`,
  click-place text открывает редактор вместо Delete
- `web/src/App.css` — `.text-editor`
- `Core/Protocol/OpValidator.cs` — text/points caps в ValidateProps:
  Patch-обход закрыт (находка бота, не юнит-тестов)
- `tests/bot.mjs` — e2e-бот: 2 SignalR-клиента, Node 24 native
  fetch/WS, deps из web/node_modules; 17 сценариев живьём
- docs: tasks T-15 → review, план следующей сессии, PLAN журнал,
  AGENTS — правило обоснования новых технологий

## 2026-11-08 — бэклог T-15..T-20 [docs]

- `tasks.md` — хвост работы: inline-текст, 8-хендл resize, undo,
  чужое выделение, список документов, perf-harness
- `roadmap.md` — ссылка на живые тикеты

## 2026-11-08 — T-14 канва-фичи [D]

- `web/src/editor.ts` — Set-выделение: marquee, Shift-click,
  group move/delete/duplicate; Shift+BR → rotate (pivot=center);
  `[`/`]` reorder, `Ctrl+D`, path двигается points+dx
- `web/src/geometry.ts` — `rotatedBounds` (AABB повёрнутого quada)
- `web/src/renderer.ts` — rot в drawObject, selection quads,
  marquee-rect, `fitBounds` (zoom `1`)
- `architecture.md` §23, `docs/roadmap.md` (новый, полный
  функционал канвы), tasks T-14

## 2026-11-08 — T-13 харденинг [D]

- `Core/Protocol/OpValidator.cs` — id/kind/z whitelist + charset,
  лимиты (64KB/64props/4KB text/4096pts)
- `Core/Room/OpRateLimiter.cs` — token bucket 120/с+burst240,
  Drop на disconnect
- `DocumentHub` — validate+limit до Room; `OpRouter` — валидация
  inbox-ops (defense in depth)
- `HardeningTests` (12 шт), `architecture.md` §22, tasks T-13

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
- T-38 lock-gates complete (ee97025, 0ddee47); shift-rotate 15° snap +
  inspector disabled/locked (fb01f4f); line endpoints in inspector
  (8bcd828)
- T-39 opacity (98d4b60, 5276472); lineWidth/radius/dash/align/box-
  stroke/hollow props wired end-to-end (addbafe, 09a2fc1, 57d9ac8,
  b1624da, 20726d3, 6d081b2); lineWidth leak fix (8894b29);
  PLAN/roadmap/checklist syncs (8c72e7d, 3823b1d, 660acdb)
- T-40 multi-inspector union translate (2385f31, 3d5e1de); layers
  cap 200 (9baec7d); Esc panel-dismiss + deps fix (6baf76b);
  inspector/minimap overlap (e1803ee); T-41 layers drag-reorder
  (dffbe45, 17b6f4a); T-42 clipboard trio (98597ed, d92b7b1);
  status.md inventory (9c0505b); ledger (6668c65)

## 2026-11-10 (auth stage 1) — T-26 начат

- Дизайн auth+ролей: Canva-модель, threat-map, group-by-tag,
  отложенное с триггерами (ef7d316)
- T-26 stage 1: UserStore Redis + BCrypt, /auth/*, hub-токен
  (query+header), серверное presence-имя; бот +7 auth-чеков
  (9d4f56d); клиент: sign-in UI + token в join + stale-closure
  fix (fd6eaca)
- Записанные дыры stage 1: /docs открыт, гость=editor, logout
  не рвёт живой сокет, /auth/login без throttle, query-токен
  в логах прокси
- T-26 stage 2: membership + роли (875b916), JoinResult.Role в
  клиенте (5e242dd). Бот +18 authz-чеков. Краши живого прогона:
  Results.Forbid() без auth-пайплайна → StatusCode(403);
  MembershipStore.TryParse → ParseRole (конвенция биндинга
  minimal-API валила стартап)
- T-26 stage 3: share-линки guest viewer/editor, grant per-op
  revalidation, revoke на живом сокете; бот +9 (97eca9b)
- T-26 stage 4: share-UI + viewer-mode; фикс фантома denied-ack
  (optimistic apply без отката → rejoin-ресинк) (коммит выше)
