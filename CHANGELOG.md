# Changelog — коммиты → файлы → таски

Карта «коммит → файлы → таск» (та же конвенция, что в Notification
Engine). Закрытые таски — `docs/done-log.md`.

Легенда: **[D]** — Devin писал код/доки · **[docs]** — документы.
Зоны «юзер руками» нет — юзер ревьюит.

---

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
