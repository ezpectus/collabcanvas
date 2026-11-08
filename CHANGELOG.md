# Changelog — коммиты → файлы → таски

Карта «коммит → файлы → таск» (та же конвенция, что в Notification
Engine). Закрытые таски — `docs/done-log.md`.

Легенда: **[D]** — Devin писал код/доки · **[docs]** — документы.
Зоны «юзер руками» нет — юзер ревьюит.

---

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
