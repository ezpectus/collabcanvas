# Roadmap — полный функционал канвы (целевая картина)

> Живые тикеты: `docs/tasks.md` — ближайшие T-15..T-20
> (текст-inline, 8-хендл resize, undo, чужое выделение, список
> документов, perf-harness).

Цель продукта: **Figma-подобный мультиплеерный канвас** — не демо,
а приложение, которым можно пользоваться. Отметки: ✅ есть · 🚧
частично/MVP · ⬜ нет.

## Холст и навигация

- ✅ Бесконечный канвас: pan (space/middle drag), zoom к курсору
- ✅ 6 типов объектов: rect, ellipse, line, text, freehand path,
  image (placeholder)
- ✅ Z-order: fractional indexing, front/back (`[` `]`), шаг слоя
  (`Ctrl+[`/`]`, single-selection)
- ✅ Zoom-to-fit (`1`); zoom-to-selection не сделан
- ✅ Minimap (`m`): dots + viewport rect, bounds кэш по version
- ✅ Grid + snap (`g`), адаптивная плотность
- ✅ Alignment guides: прилипание к краям/центрам на move-драге (T-30)
- ⬜ Pixel/ruler-линейки

## Редактирование

- ✅ Select, move; resize — 8 хендлов, оси объекта, aspect-lock,
  из центра (T-16); rotate (Shift+BR)
- ✅ Line endpoints draggable (T-27); path без хендлов (край)
- ✅ Multi-select: marquee + Shift-click (+Shift-marquee аддитив),
  group move/delete/duplicate
- ✅ Create: drag-shape; freehand path (RDP-сжатие перед проводом, T-21);
  текст — inline-редактирование dblclick/сразу (T-15)
- ✅ Duplicate (`Ctrl+D`), Delete (`Del`), Esc-отмена жеста и
  deselect, Ctrl+A select-all, arrows-nudge, fontSize `=`/`-`
- ✅ Undo/redo — compensating ops, per-client (T-17)
- ✅ Точный hit-test: stroke-distance для line/path, quad для rot≠0
  (T-29)
- ⬜ Copy/paste, alignment-команды (align left/center, distribute)
- ⬜ Группировка объектов, lock
- ⬜ Поворот хендлом + числовой ввод свойств (inspector-панель)
- ⬜ Image: настоящая загрузка/превью (нужен blob storage — props 64KB)

## Мультиплеер (сильная сторона — уже на уровне Figma-ядра)

- ✅ LWW per-property merge, server seq ordering, дедуп ретраев
- ✅ Оптимистичный apply без отката, rebase pending после reconnect
- ✅ Журнал + снапшоты + recovery, join tail/snapshot
- ✅ Presence: курсоры, TTL, rate-limit
- ✅ Выделение других юзеров — цветная рамка на объекте (T-18)
- ✅ Presence между инстансами — pub/sub relay (T-12); join-снэпшот
  видит только курсоры своего инстанса (край)
- ⬜ Комментарии, наблюдатели (follow mode), аватарки

## Персистентность и доступ

- ✅ Redis Stream журнал + снапшоты + recovery (≤1с потерь)
- ✅ Комната-владелец claim, pub/sub fanout, idle eviction
- 🚧 Нет auth — анонимные clientId; docId = открытый URL
- ✅ Список документов + `?doc=` шаринг + picker + unlist (T-19/T-32);
  прав view/edit нет — ждёт auth
- ✅ History-панель: audit-view хвоста журнала `GET /ops` (T-24);
  time-travel restore невозможен (MAXLEN) и сознательно не делается
- ✅ Экспорт PNG (T-22); SVG нет

## Нефункциональное

- ✅ 10k объектов: quadtree culling + dirty-gated rAF
- ✅ Валидация + rate-limit на проводе (T-13)
- 🚧 CORS/health есть; graceful shutdown не драинит rooms
- ⬜ Метрики (op rate, room count, frame p95) и алерты

## Что НЕ делаем (сознательно)

- OT/CRDT полный (LWW+server seq — выбор T-1)
- Co-typing текста посимвольно (Yjs — stretch)
- Mobile/touch-ввод, a11y-скринридер канвы
