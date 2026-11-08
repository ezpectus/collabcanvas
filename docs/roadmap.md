# Roadmap — полный функционал канвы (целевая картина)

Цель продукта: **Figma-подобный мультиплеерный канвас** — не демо,
а приложение, которым можно пользоваться. Отметки: ✅ есть · 🚧
частично/MVP · ⬜ нет.

## Холст и навигация

- ✅ Бесконечный канвас: pan (space/middle drag), zoom к курсору
- ✅ 6 типов объектов: rect, ellipse, line, text, freehand path,
  image (placeholder)
- ✅ Z-order: fractional indexing, bring front/back (`[` `]`)
- ⬜ Zoom-to-fit / zoom-to-selection (hotkey `1`/`Shift+1`)
- ⬜ Minimap
- ⬜ Grid + snap-to-grid/guides
- ⬜ Pixel/ruler-линейки

## Редактирование

- ✅ Select, move, resize (BR-handle), rotate (Shift+BR)
- ✅ Multi-select: marquee + Shift-click, group move, group delete
- ✅ Create: drag-shape; freehand path; текст — placeholder
- ✅ Duplicate (`Ctrl+D`), Delete (`Del`)
- 🚧 Resize: только BR-угол (нет всех 8 хендлов, нет aspect-lock)
- 🚧 Text: создаётся, но не редактируется inline (нет text-edit mode)
- ⬜ Undo/redo — нужен compensating-op, журнал уже есть (stretch T-1)
- ⬜ Copy/paste, alignment (align left/center, distribute)
- ⬜ Группировка объектов, lock
- ⬜ Поворот хендлом + числовой ввод свойств (inspector-панель)
- ⬜ Image: настоящая загрузка/превью (сейчас плейсхолдер)

## Мультиплеер (сильная сторона — уже на уровне Figma-ядра)

- ✅ LWW per-property merge, server seq ordering, дедуп ретраев
- ✅ Оптимистичный apply без отката, rebase pending после reconnect
- ✅ Журнал + снапшоты + recovery, join tail/snapshot
- ✅ Presence: курсоры, TTL, rate-limit
- 🚧 Выделение других юзеров показывается цветом курсора — нет
  цветной рамки на объекте у чужих
- 🚧 Presence между инстансами — канал есть, снэпшот per-instance
- ⬜ Комментарии, наблюдатели (follow mode), аватарки

## Персистентность и доступ

- ✅ Redis Stream журнал + снапшоты + recovery (≤1с потерь)
- ✅ Комната-владелец claim, pub/sub fanout, idle eviction
- 🚧 Нет auth — анонимные clientId; docId = открытый URL
- ⬜ Список документов, шаринг по ссылке с правами (view/edit)
- ⬜ Version history из журнала (данные уже лежат)
- ⬜ Экспорт PNG/SVG

## Нефункциональное

- ✅ 10k объектов: quadtree culling + dirty-gated rAF
- ✅ Валидация + rate-limit на проводе (T-13)
- 🚧 CORS/health есть; graceful shutdown не драинит rooms
- ⬜ Метрики (op rate, room count, frame p95) и алерты

## Что НЕ делаем (сознательно)

- OT/CRDT полный (LWW+server seq — выбор T-1)
- Co-typing текста посимвольно (Yjs — stretch)
- Mobile/touch-ввод, a11y-скринридер канвы
