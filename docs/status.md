# Статус CollabCanvas — инвентарь (2026-11-10)

Что реально работает, что осталось и почему, что покрыто тестами,
честные края. Без выдуманных тикетов — если пункт здесь, у него есть
причина существовать. Обновлять по мере закрытия.

## ✅ Умеет сейчас (проверено сборкой/тестами/ботом)

**Мультиплеер-ядро**
- LWW-документ, серверный seq, дедуп ретраев, журнал Redis Streams +
  снапшоты, recovery после рестарта/реконнекта
- Presence: курсоры, TTL-свип, кросс-инстанс через pub/sub
- Валидация ops (лимиты text/points на Create И Patch — бот это
  поймал), rate-limit, комната-eviction по неактивности
- `/docs` список, `?doc=` шаринг-ссылки, `DELETE /docs/{id}` unlist,
  `/ops?doc=&n=` аудит-tail (честно: НЕ time-travel — MAXLEN)

**Редактор (Figma-паритет на desktop)**
- Инструменты: select/rect/ellipse/line/text/path
- Жесты: move, resize 8 хендлов (shift=aspect, alt=center), rotate
  (9-я ручка сверху + shift+BR, shift=шаг 15°), endpoints линии,
  marquee (shift=добавка), pan (space/middle/right)
- Multi-select: move/resize(union-box)/rotate/delete/dup/align/
  distribute/nudge — одна undo-запись на жест
- Undo/redo компенсирующими ops (журнал не откатывается), кап 100
- Lock (ctrl+shift+L): click-through, все мутационные пути гейтятся,
  unlock через layers-панель
- Inspector: x/y/w/h/rot/fontSize/lineWidth/radius/opacity/dash/
  align/endpoints; multi — union x/y translate
- Стиль: fill/stroke/⊘none/opacity/radius/dash/fontSize/align,
  fill|stroke-тумблер
- Clipboard: copy/cut/paste (JSON, union-якорь у курсора, кап 200)
- Align/distribute, snap-to-grid (g), guides, z-стек [/]/ctrl+[/],
  layers-панель (поиск/lock/drag-reorder, кап 200 строк)
- Minimap (m), zoom fit (1 / shift+1), PNG-экспорт, help (?)
- Esc: отмена жеста с ревертом → закрытие панели → deselect

**Перф**
- QuadTree-culling + индекс, hit-test по кваду/штриху (не AABB),
  RDP-сжатие path, stress-10k локальный (журнал не срёт)

## ⬜ Реальный бэклог (только обоснованное)

| Таск | Размер | Почему нужен / что блокирует |
|---|---|---|
| T-26 Auth + share-права | L | Все 4 этапа в review: users/sessions, роли (owner/admin/editor/viewer), link-grant'ы guest viewer/editor, share-UI + viewer-mode, бот +34 auth-чеков. Остаточные дыры — в T-26 (throttle логина, rename, per-op Redis-стоимость) |
| Image upload | L | `image` kind есть со стабом. Нужен blob store (props-лимит 64KB) + upload-эндпоинт — инфра-решение |
| Группировка объектов | — | ✅ T-35 в review: flat tag-модель (выбор юзера), ctrl+g/ungroup, клик-селект по тегу. Вложенность/вход в группу — вне скоупа по дизайну |
| Co-typing текста | XL | Операционный уровень вместо whole-string LWW. Сознательно отложено — дорого |
| Doc-rename/metadata | — | ✅ T-27 в review: `doc:{id}:meta` + PATCH owner/admin |
| Mobile/touch | L | Pointer-events слой, жесты pinch/long-press. Desktop-first пока осознанно |
| Scale-hardening | M-L | Ownership fencing, join-cache, инкрементальный индекс — преждевременно без реальной нагрузки |
| Комментарии | ? | Сомнительно на этом этапе — сначала auth |

Сознательно НЕ делаем: rulers (ниша), следование за курсором,
шаблоны/template-маркет — канва-масштаб, а не канва-копия.

## 🧪 Покрытие тестами

- 47 xUnit (LWW, fractional index, room order, chaos/reconnect)
- Node-харнессы: resize-математика 9/9, RDP path
- Live-бот 56/56: create/patch/delete, presence, rate-limit,
  reconnect, /ops, DELETE /docs + auth (register/login/me/имя)
  + authz (роли, revoke на живом сокете, admin-границы, гейты)
  + links (forged grant, guest viewer/editor, cap ролей, revoke)
- НЕ покрыто UI-жесты: бот wire-уровня, хендлы/marquee/lock —
  ручная проверка или будущий browser-тест (если потребуется —
  отдельное решение про playwright vs самописный)

## 🐛 Найдено и исправлено за последние сессии

- Patch обходил лимиты text/points (security)
- AABB hit-test крал клики у диагоналей/повёрнутых
- Esc-реверт затирал remote-пропы → сужен до gesture-ключей
- Lock: 3 дыры гейтинга (клавиатура, handle-жесты, group-move)
- lineWidth — глобальное ctx-состояние, текло между объектами
- Inspector показывал протухшие числа навсегда (key без значения)
- Хинты в `?` врали про alt=center — теперь реализовано
- T-36 закоммичен сломанным → фикс-коммит, честно в леджере
- Layers-панель вешала бы вкладку на 10k → кап 200 строк
- Дрейф доков ×4: roadmap, architecture, changelog, PLAN

## Честные края (знаем и принимаем)

- Аудит ≠ ревайнд (MAXLEN), снапшот — точка восстановления
- Lock — UX-гейт, не permission (remote-опы объект двигают)
- Paste до первого mouseMove → world(0,0); PNG ловит курсоры
- Журнал append-only: undo = новые ops, размер растёт вечно
- Image kind — placeholder, реальный upload за инфра-решением
