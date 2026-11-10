# Backlog — тикеты CollabCanvas

Код во всех тикетах пишет Devin. Юзер ревьюит по чеклисту тикета
и отвечает на gate-вопросы. `done` = ворота пройдены (AGENTS.md).

**Статусы:** `todo` → `in-progress` → `review` → `done`.

**Размеры:** XS < вечера · S ~вечер · M ~2–3 вечера · L ~неделя.

---

## T-1 · Исследование + архитектура · `review` · S

*Документ готов: `docs/architecture.md` (§1–13). Ждёт ревью юзера:
ответить на gate-вопросы §13.*

**Контекст.** До кода — дизайн. Настоящая Figma не делает полный
OT/CRDT: центральный сервер снимает сложность — каждое свойство
объекта = LWW-регистр («last» = последний дошедший до сервера,
без timestamp'ов), порядок детей — fractional indexing, состояние
документа в памяти процесса-комнаты + журнал опов + периодические
снапшоты.

**Devin пишет:** `docs/architecture.md` — модель объектов
(rect/ellipse/line/text/freehand/image), формат op'ов
(create/update/delete/reorder/setProps + seq), apply-семантика,
схема журнала и снапшотов, presence-модель, выбор хранилищ.

**Ревью-чеклист:** почему LWW без timestamp корректен только при
центральном сервере · где граница «эфемерное» (presence) vs
«персистентное» (ops) · что теряется при рестарте комнаты.

**Gate:** почему центральный сервер убивает сложность OT? Что в
этом дизайне самое хрупкое?

---

## T-2 · Скелет решения · `review` · S

*Скелет собран и проверен: `dotnet build` чисто, 3/3 тестов,
`npm run build` + `oxlint` чисто. Ждёт ревью юзера.*

**Что написано:** `CollabCanvas.sln` + `src/CollabCanvas.Core`
(протокол-контракт `Protocol/Messages.cs`: JoinDocument,
OpSubmit/OpAck/OpBroadcast, PresenceUpdate, OpType) +
`src/CollabCanvas.Api` (`Program.cs`: health с ping'ом Redis —
fail-open 503 degraded; CORS для :5173/:3100; MapHub) +
`Hubs/DocumentHub.cs` (join/leave — реальные SignalR-группы;
SubmitOp → честный `accepted:false "not-implemented"` до T-4;
presence fanout в группу) + `tests/` (health-контракт, negotiate,
round-trip протокола — `WebApplicationFactory`) + `web/` (Vite 6 +
React 18 + strict TS: `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes` и др.; панель join через
`@microsoft/signalr`; canvas-заглушка) + `docker-compose.yml`
(redis host:6380 — 6379 занят Notification'ом; api :8090;
web :3100 через nginx c ws-upgrade) + `.github/workflows/ci.yml`
(api job + web job) + `docs/diagrams/mmd/system.mmd`.

**Ревью-чеклист:** кто за что отвечает из сервисов · что умирает
при падении каждого · где граница Core/Api (подсказка: Core —
чистые контракты без зависимостей; Api — транспорт/хабы; зачем
вообще два проекта?) · `SubmitOp` сейчас лжёт клиенту не «упал»,
а честно отвечает not-implemented — почему это лучше, чем молча
принимать и терять?

**Gate:** назвать каждый сервис и эффект его падения. Что
происходит, когда падает redis — health что покажет, хаб умрёт?

---

## T-3 · Модель документа + op-протокол · `review` · M

*Реализовано: `Core/Model/Document.cs` + 6 apply-тестов (9/9 весь
набор). Архитектура §14, диаграмма `mmd/doc-model.mmd`.*

**Что написано:** каждое свойство — LWW-регистр `(objId, prop) →
(value, seq)`; `_kind`/`_z` — тоже регистры; существование =
`createSeq` vs `deleteSeq`. Apply любого op в любом порядке →
конвергенция (проверено шаффл-тестом с seed). Patch удалённого
объекта пишет регистры, но не воскрешает его — только Create с
более высоким seq.

**Поймано при реализации:** Redis-коннект в `Program.cs` был
eager — тест падал без живого Redis → `abortConnect=false`
(мультиплексер ретраит в фоне, health → degraded). Тесты теперь
герметичны.

**Ревью-чеклист:** проследи `WriteProp` — почему `seq <=` (а не `<`)
это и есть идемпотентность бесплатно · найди, где `Objects()`
решает видимость · вопрос на подумать: два `Create` одного id с
seq 5 и 12 — что видно и почему регистры не «перепутались»?

**Gate:** два юзера двигают один rect в разные стороны — кто
выигрывает и почему все реплики согласны? Op прилетел дважды —
что произойдёт? Удалённый объект получил patch с большим seq —
воскреснет? Почему?

---

## T-4 · SignalR hub + RoomManager · `review` · M

*Реализовано: `Core/Room/Room.cs` + `RoomManager`, хаб переписан
на реальный Room, 5 тестов комнаты (14/14 набор). §15 +
`mmd/seq-flow.mmd`.*

**Что написано:** `Room.Submit` под одним lock — dedup по
`(clientId, clientSeq)` → seq = lastSeq+1 → apply → journal.
Ретрай возвращает исходный seq (`IsNew=false`). Хаб — адаптер:
broadcast группе (включая автора — reconcile по эхо-seq), ack
автору. `Join(lastSeq)` → ops seq>lastSeq.

**Ревью-чеклист:** в `Submit` найди два места, где дедуп может
промахнуться (подсказка: `_ackIndex` vs `_lastClientSeq` — что
каждый ловит?) · тест `Submit_ConcurrentClients` доказывает
gapless seq — почему lock, а не Interlocked? · broadcast идёт
автору тоже — где в протоколе поле, по которому автор узнает свой
op?

**Gate:** клиент отвалился на 5 секунд и вернулся — как догоняет?
Клиент отправил op, WS умер до ack — что шлёт клиент и что
отвечает сервер? Два серверных инстанса и одна комната — что
ломается?

---

## T-5 · Журнал + снапшоты + реконнект · `review` · M

*Реализовано: `Core/Journal/IOpJournal.cs` (+ InMemory),
`Api/Journal/RedisOpJournal.cs`, `Document.Restore`, recovery +
join-ветки в `Room.cs`. 6 тестов (20/20 набор). §16 +
`mmd/recovery.mmd`.*

**Что написано:** sync-интерфейс `IOpJournal` (append/readSince/
snapshot/FirstSeq — живой базовый seq журнала). Room при старте:
snapshot → `Restore` (регистры на snapSeq) → replay всего выжившего
журнала → dedup-индексы пересобираются из journaled ops **бесплатно**
(ретрай после рестарта → исходный seq). Snapshot каждые 100 ops под
тем же локом. Join: `FirstSeq <= lastSeq <= LastSeq` → хвост; иначе
(урезано/будущее) → snapshot + ops с snapSeq. Redis: stream
`doc:{id}:ops` MAXLEN ~10k + `doc:{id}:snap`. Redis-журнал fail-open:
сбой → комната деградирует до in-memory (наблюдаемо в /health).

**Поймано при реализации:** (1) `Props.OrderBy` сериализовался
массивом `{Key,Value}` — Restore падал, фикс `SortedDictionary`;
(2) кешированная `_journalBase` протухала при урезании — FirstSeq
теперь читается live.

**Ревью-чеклист:** проследи порядок apply→append→broadcast в
`Submit` — почему append внутри лока убивает гонку «snapshot vs
ops» · в `Restore` найди, почему `propSeq=snapSeq` делает replay
ops≤snapSeq бесплатным · где граница dedup: журнал урезан + рестарт
→ что вернёт ретрай? · fail-open RedisOpJournal — найди место, где
op молча теряет durability (это осознанно, §16.1).

**Gate:** сервер убит посреди op — что теряется и где читается
доказательство? Клиент с lastSeq=5, журнал урезан до 106 — что он
получит и почему? Dedup переживает рестарт — откуда берётся
`_ackIndex`?

---

## T-6 · Fractional indexing · `review` · S

*Реализовано: `Core/Model/FractionalIndex.cs` + 6 тестов (26/26
набор). §17 + `mmd/z-order.mmd`.*

**Что написано:** `Between(a,b)` над base-62 алфавитом — общий
префикс рекурсивно (недостающий символ = `'0'`), середина цифрового
промежутка или углубление разряда. `First/After/Before` для краёв.
Инвариант «не кончается на `'0'`» — между `a` и `a0` ключа не
существует, такие входы бросают. Детерминизм = бесплатный merge
на всех репликах.

**Поймано при реализации:** `a?[n..]`/`a?[1..]` падали, когда общий
префикс длиннее строки (недостающие символы — `'0'`, и `b` может
держать `'0'` в середине) → безопасный `Tail`.

**Ревью-чеклист:** проследи `Between("a","a1")` → почему `a0V`
корректен и почему `a0` — невалидный ключ · где в `Between`
детерминизм (что сломал бы `Random`?) · тест с `Random(42)`:
почему 200 вставок в случайные позиции обязаны дать отсортированный
порядок.

**Gate:** сценарий исчерпания точности — назови его (подсказка:
что происходит с float64-midpoint после ~50 вставок между двумя
соседями, и что делает строка вместо этого?)

---

## T-7 · Presence · `review` · S

*Реализовано: `Core/Presence/PresenceTracker.cs`,
`Api/Presence/PresenceSweeper.cs`, хаб дописан (snapshot на join,
rate-limit фанаута, disconnect → presence-left). 5 тестов (31/31).
§18 + `mmd/presence.mmd`.*

**Что написано:** трекер `clientId → latest update` с двумя
механизмами в одном `Update`: TTL (10с, часы снаружи — `now`
параметром) и rate-limit фанаута (100мс на клиента — дропает
broadcast, но хранит значение). Heartbeat = обычный Update, новых
типов нет. Два пути смерти: disconnect (мгновенный `presence-left`)
и sweeper каждые 2с (≤12с призрак). Joiner получает
`presence-state` снэпшот живых курсоров.

**Ревью-чеклист:** найди, почему rate-limit дропает фанаут, но НЕ
lastSeen — что было бы, дропай он оба? · sweeper vs disconnect:
какой путь ловит зависшую вкладку с живым WS и почему ·
`presence` шлётся `OthersInGroup`, а `op` — всей группе: почему
разная политика?

**Gate:** клиент закрыл ноут — когда исчезнет его курсор и кто это
делает? А если вкладка зависла, но WS жив? Клиент шлёт 60
апдейтов/сек — что видят остальные?

---

## T-8 · Фронт: рендер · `review` · M–L

*Реализовано: `web/src/{model,session,renderer,fractionalIndex}.ts`
+ `App.tsx`. §19 + `mmd/client-render.mmd`. `JsonStringEnumConverter`
в Api — OpType летает строкой. lint+build чисто, 31/31.*

**Что написано:** `DocModel` — TS-зеркало LWW-документа
(apply/restore/objects та же семантика, что у сервера);
`Session` — join → snapshot/tail → live ops, reconnect → rejoin с
lastSeq; `Renderer` — владелец canvas+rAF, рисует только по dirty,
bbox-culling, pan/zoom с якорем курсора, dpr; per-kind draw для 6
типов; remote cursors поверх; stats-overlay (objects/drawn/drawMs/
fps) на ~10Гц. Кнопки: Join, Spawn rect (реальный op), Stress 10k
(ghost-объекты вне журнала, не трогают lastSeq), Clear.

**Ревью-чеклист:** кто владеет циклом кадра и почему React только
монтирует · найди все источники `markDirty` — что НЕ вызывает
перерисовку? · `debugFill` обходит журнал — почему это безопасно
для seq-контракта и где бы это сломалось · утечки: `stop()` — что
снимается, что нет.

**Gate:** почему 10k объектов не убивают кадр — назови три места,
где работа сокращается? Где остаётся лишний рендер (`objects()`
каждый кадр)? Клиент теряет WS на 5с с 200 пропущенными ops —
проследи путь догона.

---

## T-9 · Фронт: редактирование + QuadTree · `review` · M–L

*Реализовано: `web/src/{geometry,quadtree,editor}.ts`, session
переписан на optimistic+rebase, model → nested regs + version,
renderer → quadtree-culling + selection. `Document.Objects()` на
сервере тоже ушёл с O(n²) на вложенные регистры. §20, диаграмма
обновлена. lint+build чисто, 31/31.*

**Что написано:** оптимистичный apply с дробным temp-seq
(`lastSeq+ε`, cap 0.9995 — никогда не целое): отката нет, LWW
сходится; pending[clientSeq] → rebase+resubmit на rejoin.
Инструменты select/move/resize(BR)/create(rect,ellipse,line,text)/
Delete; драг: локальный apply каждый кадр + wire-patch 80мс +
flush на mouseup; дельты от props на mouseDown. QuadTree cap8/
depth10, rebuild-on-version; hit-test topmost по z (bbox).

**Ревью-чеклист:** найди все три места, где temp-seq может
«обмануть» кого-то (remote op, echo, lastSeq) — и почему каждое
покрыто · `patchThrottled` vs `applyLocal` — что едет на провод, а
что нет; сколько ops генерирует 5-секундный драг? · hit-test
topmost — почему sort desc z, а не первый попавшийся.

**Gate:** локальный apply и сервер разошлись — где в коде точка
примирения (и почему это НЕ откат)? Чем QuadTree лучше
`array.find` на 10k — и где он хуже? Юзер драгает, WS умер —
что увидит он, а что увидят другие после его rejoin?

---

## T-10 · Scale-out + хаос · `review` · M

*Реализовано: `IRoomTransport` (Core), `RedisRoomTransport` +
`OpRouter` (Api), хаб на owner/non-owner ветки, join из журнала на
не-владельце, клиентский reconnect backoff с full jitter.
`ChaosTests` (34/34). §21 + `mmd/scaleout.mmd`.*

**Что написано:** owner-per-doc через `SET NX` claim (TTL 15с,
renewal 5с). Каналы `doc:{id}:in` (submit→owner) / `doc:{id}:out`
(seq'd op→все). `OpRouter`: inbox → Room.Submit → outbox; outbox →
SignalR-группа — uniform fanout. Non-owner ack `seq=-1 forwarded`,
join — из журнала. Клиент: `random × min(30с, 2^n)` backoff.

**Поймано/принято:** claim advisory без fencing — окно split-brain
задокументировано (§21.1); Redis-сбой → локальное владение (тихий
split-brain, /health degraded — единственный сигнал); pub/sub
at-most-once; presence остался per-instance.

**Ревью-чеклист:** проследи путь op'а A→инстанс1→владелец→B на
диаграмме · найди два места, где op может потеряться при pub/sub
at-most-once, и что их лечит · dedup на владельце: почему router
бродкастит дубликаты заново · где граница «это MVP, а это уже
нужен fencing».

**Gate:** та же комната на двух инстансах — где теперь точка
упорядочивания и что бывает, когда claim теряется посреди сессии?
Клиент на non-owner инстансе получил ack — как он узнает seq?

---

## T-11 · Финиш: README + демо + perf · `review` · S

*Реализовано: `README.md` (EN: картинка архитектуры, запуск,
таблица «what's proven», honest limitations) + `docs/guides/demo.md`
(4 акта: конфликт, сбои, scale-out, perf + gate-вопросы).*

**Perf-pass (честный отчёт):** автоматического harness'а нет —
критерий 10k@60fps проверяется overlay (`drawn`/`drawMs`/`fps`) на
живом демо. Известные узкие места по коду: `objects()` полная
сортировка при каждой пересборке SceneIndex (O(n log n) на op, не
на кадр — rebuild по version); `visibleIn` аллоцирует массивы на
кадр; join-шторм N×XRANGE по журналу без кеша; presence sweeper
последовательный по комнатам. Op-latency путь: invoke→lock→apply→
XADD→PUBLISH→group — один lock-hop, без очередей; локально это
единицы мс, узкое место при росте — сериализация broadcast per op.

**Ревью-чеклист:** README покрывает «зачем и как» без воды ·
демо-сценарий действительно создаёт конфликт (не просто «два окна
совпадают») · таблица proven/not-proven — есть ли пункт, с которым
не согласен?

**Gate:** финальный прогон — объяснить путь op'а от мышки до
чужого экрана и назвать каждое место, где система может
обосраться.

---

## T-12 · Полировка: path + presence scale + eviction · `review` · S

*Реализовано вне очереди (юзер отдыхает): три задокументированных
края закрыты. 35/35, lint+build чисто.*

**Что написано:**

1. **Freehand `path` tool** — недостающий тип из §1. Локальный
   create/patch пока драгаем (провод молчит — точек сотни, журнал
   не засираем), настоящий Create с полным списком точек — один op
   на mouseup. Отмена (без движения) — `applyLocal Delete`, на
   провод вообще ничего не уходит.
2. **Presence cross-instance** — закрыт край §21.6: канал
   `doc:{id}:pres` через `IRoomTransport.PublishPresenceAsync`,
   OpRouter релеирует в группу; клиент сам фильтрует свой clientId.
   Redis-сбой → fail-open локальной доставкой.
3. **Room eviction** — `EvictIdle(10min)` в том же тике sweeper'а:
   комната без presence и активности выгружается из памяти;
   восстановление из журнала при следующем контакте — recovery
   из T-5 и есть exit-стратегия.

**Честные края:** presence-state на join видит только курсоры
СВОЕГО инстанса (трекер per-instance — чужие курсоры доедут живьём
через :pres, но снэпшот их не содержит); eviction комнаты-
владельца оставляет claim в Redis — op через :in пересоздаст
комнату (стоимость — один replay); path не упрощается (нет
RDP-simplification) — длинный штрих = большой payload.

**Ревью-чеклист:** почему path шлёт Create один раз на mouseup, а
не патчит по ходу — что бы сломалось при wire-патчах точек? ·
`PublishPresenceAsync` fail-open: найди, где курсор может потеряться
между инстансами (подсказка: joiner на другом инстансе) · eviction:
какой случай выгрузит комнату с активными зрителями — и почему
это безопасно.

**Gate:** зритель без мыши сидит в комнате 15 минут — выгрузится
ли она и что это меняет? Два инстанса, клиент на B джойнится —
видит ли он курсоры клиентов с A и почему?

---

## T-13 · Харденинг · `review` · S

*Реализовано: `OpValidator` + `OpRateLimiter` (Core), интеграция в
хаб и OpRouter. `HardeningTests` (12 шт → 47/47 набор). §22,
`docs/roadmap.md`.*

**Что написано:** валидация op'ов до комнаты (id/kind/z whitelist,
размерные лимиты, charset id'ов — `:` запрещён ради Redis-ключей),
token bucket 120/с+burst240 per-connection с Drop на disconnect,
повторная валидация в OpRouter для inbox-ops.

**Ревью-чеклист:** почему «a0» отвергается как z, хотя сортировать
его можно · где лимит НЕ защищает (семантика значений props) ·
rate-limit per-connection — какой спам он НЕ ловит.

**Gate:** бот шлёт 1000 валидных create/сек с одного сокета — что
тормозит первым и где это видно? А с 100 сокетов?

---

## T-14 · Канва-фичи: multi-select/rotate/dup/z-order/fit · `review` · S

*Реализовано: editor переписан на Set-выделение, rot-рендер,
rotatedBounds, marquee, Ctrl+D, `[`/`]`, `1`-zoom-fit. lint+build
чисто. §23, roadmap обновлён.*

**Ревью-чеклист:** `orig` теперь Map — найди, почему move-дельта
per-object, а не общая · Shift+BR = rotate: как считается угол и
почему pivot — центр, а не TL · hit-test повёрнутого объекта —
какой клик выделит воздух.

**Gate:** повёрнутый rect тащат за BR — что произойдёт с ресайзом
и почему это honest edge? Путь op'а от marquee до чужого экрана.

---

## T-15 · Текст: inline-редактирование · `review` · S

*Реализовано 2026-11-09 (`96ad89c`). dblclick/click-place → DOM-
textarea поверх объекта; keystrokes = applyLocal, commit (Enter/
blur) = один Patch; Esc — локальный откат; Shift+Enter — newline.
Плюс `tests/bot.mjs` — e2e-бот на двух SignalR-клиентах (17/17
живьём): поймал реальную дыру — Patch обходил лимиты text/points,
проверки сидели только в Create-ветке → вынесены в ValidateProps.
lint+build чисто.*

**Края:** overlay позиционируется на открытии — pan/zoom во время
редактирования оставляет textarea на месте (honest edge); co-typing
по-прежнему LWW-строка (§12.2); удалённый Delete объекта во время
редактирования — commit патчит мёртвые регистры (безвредно).

**Gate:** двое печатают в один textbox — кто выигрывает и где это
видно в op-потоке? · почему applyLocal на каждый кейстрок, а не
submit — что видит удалённый клиент до commit'а?

---

## T-16 · Resize: 8 хендлов + aspect-lock · `review` · S

*WIP закоммичен 2026-11-09 (`b6c8a56`): 8 хендлов у box-типов
(rect/ellipse/text/image), дельта в осях объекта (R(-rot)), якорь —
противоположная сторона/угол pixel-fixed, Shift = aspect-lock,
Shift+BR = rotate. lint+build чисто, живьём НЕ проверено — первым
делом прогнать руками + `tests/bot.mjs`.*

**Осталось:** line/path без хендлов (масштаб точек — отдельный op,
honest edge); multi-select resize (общий bbox) НЕ сделан — группу
пока нельзя ресайзить; Alt «от центра» не реализован — отложено.

**Gate:** rect повёрнут на 45° — за NE-хендл тянем на северо-
восток: какие две координаты меняются в props? · почему якорь
пересчитывается в world, а не в local?

---

## T-17 · Undo/redo — compensating ops · `review` · M

*Реализовано 2026-11-10 (`508eec6`). Per-client undo: инверсия
захватывается до optimistic-apply, Ctrl+Z шлёт её как новые ops.
Покрыты жесты (одна запись на drag), create/place/path, delete→
Create-resurrect, group, duplicate, reorder, text commit. Кап 100.*

**Honest edge:** Patch-инверсия пишет `null` для ключей, которых не
было (в протоколе нет prop-delete) — рендер читает как default.
Undo чужих правок — LWW: мой op новее и выигрывает, это честно
для per-client модели, но юзер может «отменить» чужое действие.

**Devin пишет:** локальный undo-стек на клиенте: каждый submit
запоминает инверсию (перед записью читаем старые значения
регистров), Ctrl+Z шлёт НОВЫЙ op со старыми значениями — история
линейна, журнал остаётся истиной. Per-client undo only (Figma тоже).

**Края:** инверсия чужих правок — undo меняет то, что уже трогал
другой юзер (LWW: мой op новее); delete→create инверсия =
восстановление props (читаем регистры до tombstone); pending
queue на reconnect.

**Gate:** A и B пишут в один объект по очереди, A жмёт undo — что
видит B и почему это честно?

---

## T-18 · Чужое выделение цветной рамкой · `review` · XS

*Реализовано 2026-11-10 (`361547d`). selection едет в presence
(уже было в протоколе); рамки цветом юзера, stale-id на удалённых
объектах скипаются. Бот проверяет провод (18/18).*

**Devin пишет:** `PresenceUpdate.selection` уже в протоколе —
шлём selectedIds с presence; renderer рисует рамку цвета юзера
поверх объектов. Throttle с тем же presence-каналом.

**Края:** stale-выделение на удалённом объекте; selection при
rate-limit дропах (хранится, фанаут режется — ок).

**Gate:** юзер вышел с висячим выделением — кто и когда снимает
рамку?

---

## T-19 · Документы: список + шаринг · `review` · M

*Реализовано 2026-11-10 (`e117388`). Redis `docs` Set на join,
`GET /docs` (fail-open []), `?doc=` + share-кнопка + select-picker,
`Session.switchDoc` на том же коннекте. Бот-док виден в списке.*

**Края:** docId — секретный URL, auth'а нет: перечисление через
/docs открывает scraping-вектор (rate-limit на op, не на GET —
задокументировано); удаления документов нет — список растёт.

**Devin пишет:** index-эндпоинт списка docId (Redis scan или Set
`docs`), имя doc в URL (`?doc=`), кнопка «share» = копия ссылки.
Без auth — docId остаётся секретным URL'ом.

**Края:** перечисление = scraping-вектор (rate-limit помогает,
но docId-гадание не закрыто — честно в §22); удаление документа?

**Gate:** как юзер «теряет» документ сейчас и что меняет список?

---

## T-20 · Perf-harness: автоматические замеры · `review` · S

*Реализовано 2026-11-10. `tests/perf.mjs`: tsc-emit реальных
модулей (без новых deps) → 10k/50k замеры индекса/cull/objects() +
op RTT через живой API. Цифры в README. Canvas draw-calls headless
не гоняются — честно отмечено.*

**Devin пишет:** витрина perf: автотест рендер-кадра на 10k
(headless-canvas нет — Node bench на SceneIndex+draw-list сборку),
op-latency замер через ws-клиента, отчёт в stats-overlay.
Документируем реальные цифры в README вместо «проверено глазами».

**Gate:** где сейчас самая дорогая мс в кадре на 10k и чем это
доказано?

---

## Следующая сессия — план на утро (зафиксировано 2026-11-09 ночью)

0. **Поднять стек:** `docker compose -p collabcanvas up -d --build`
   (Docker Desktop погашен — стартует ~1-2 мин). Данные в томах
   целы.
1. **T-16 ручная проверка** — код в `review`: поверь глазами
   ресайз за все 8 хендлов, повёрнутый объект (дельта в осях),
   Shift aspect-lock, Shift+BR rotate. Баг → фикс до стадий.
2. `node tests/bot.mjs` — регресс провода.
3. **T-18** — чужое выделение рамкой (XS, быстрый выигрыш).
4. **T-17** — undo/redo через compensating ops (M — главный кусок).
5. T-19 (список документов) / T-20 (perf-harness) — по остатку сил.
6. Прогон `tests/bot.mjs` после каждой стадии — регресс-страж.

**Правило (новое, от юзера):** перед добавлением ЛЮБОЙ технологии/
зависимости — сначала обосновать: что решает, в каких ситуациях
нужна, почему без неё нельзя. Без обоснования — не добавлять.

## T-21 · RDP-сжатие freehand · `review` · XS
Реализовано (`ebe7942`): `simplifyPoints` в geometry, eps=1wu перед
Create — path перестал быть самым жирным op'ом. path.test.mjs 6/6.
Край: локальный apply до эха показывает сырую линию, эхо заменяет
упрощённой — микро-«щелчок» формы возможен.

## T-22 · Цвет + PNG-экспорт · `review` · XS
Реализовано: swatch в тулбаре = brush для новых + repaint выделения
(stroke для line/path, fill иначе, undo-aware). PNG — canvas
.toDataURL. Край: курсоры/хендлы попадают в снимок (frame artifacts).

## T-23 · Snap-to-grid · `review` · XS
Реализовано: G — toggle; snap к 10wu на mouseDown (движение через
дельты от snapped-старта); сетка адаптивной плотности в renderer
(step*2 пока <8px). Край: resize-delta не снаппит абсолют — якорь
на сетке, тянуть можешь куда угодно.

## T-24 · Version history (audit view) · `review` · M
Реализован аудит-просмотр: `Tail(n)` на IOpJournal (Redis XREVRANGE
ограниченный — без скана 10k), GET /ops?doc=&n=, панель «history»
в клиенте (seq/type/client). Restore-from-seq отложен: MAXLEN
стирает предысторию, настоящий rewind невозможен — панель это
аудит, не машина времени, это прямо записано в комментарии кода.

## T-25 · Minimap · `review` · S
Готово: `m` toggle, screen-space оверлей в главном канвасе — точка
на объект + прямоугольник вьюпорта; docBounds кэшится по
model.version. По умолчанию выкл (10k точек — ~2мс/кадр).

## T-26 · Auth + share-права · `in-progress` · L
Дизайн: `docs/design/auth-and-roles.md` (Canva-модель, threat-map).
- **stage 1 `review`** (9d4f56d, fd6eaca): UserStore в Redis
  (`user:{login}` + `sess:{token}` TTL 7d sliding, BCrypt wf11 —
  НЕ самописная крипта), /auth/register|login|me|logout, uniform 401
  (anti-enumeration). Токен на WS: `access_token` query ИЛИ Bearer-
  header (браузер не умеет хедеры на WS-upgrade, Node-клиент умеет).
  Presence-имя штампует сервер — self-claimed игнорируется (бот:
  шлём name:'hacker', комната видит логин). Клиент: localStorage
  cc_token, sign-in UI, курсоры с логинами.
- **stage 2 `review`** (875b916, 5e242dd): MembershipStore —
  `doc:{id}:members` hash login→role + `user:{login}:docs` +
  `owned:docs`. Owned-док только через POST /docs (автор-создатель =
  owner); implicit-join unowned = legacy-open (first-claim отклонён —
  логин не должен красть анонимные доки). Enforce: JoinDocument deny
  (HubException), SubmitOp per-op (revoke ложится на следующий op —
  живой сокет не спасает), Presence gated, /docs отфильтрован,
  DELETE+/ops по роли, members-эндпоинты (admin не сажает admin/
  owner). Бот +18 authz-чеков. Поймано 2 краша на живом прогоне:
  Results.Forbid() тянет ASP.NET auth-пайплайн (→StatusCode 403);
  MembershipStore.TryParse столкнулся с конвенцией биндинга
  (→ParseRole). Край: EffectiveRole = 1-2 Redis-чтения на op —
  без кэша намеренно (кэш = окно revocation).
- **stage 3 `review`** (97eca9b): `doc:{id}:links` hash token→role,
  линк отчеканивает ТОЛЬКО viewer|editor (owner/admin-линк = отдать
  док — отказ). EffectiveRole: member>link>legacy. Грант кэширован
  на соединении и перевалидируется НА КАЖДОМ op — revoke валит живой
  сокет следующим op'ом. Эндпоинты GET/POST/DELETE /docs/{id}/links
  (admin+). Клиент: ?grant= из URL в каждый (re)join. Бот +9.
- **stage 4 `review`** (1e1868a): share-панель (минт линков в
  буфер, seat members, список), viewer-mode — tools/inspector
  прячутся + `session.submit()` = единая точка отказа для
  role==='viewer' (косметика; enforce на сервере). Пойман баг:
  denied-ack чистил pending, но optimistic-apply оставлял фантом —
  теперь denied триггерит rejoin-ресинк.
- **Дыры стадии 1, честно** (задокументированы, чинятся на 2+):
  /docs по-прежнему перечисляет всё · гость = полный редактор
  (legacy, флип в stage 2) · logout убивает sess, но ОТКРЫТЫЙ
  сокет держит resolved uid — живёт до дисконнекта (per-op check
  нужен) · /auth/login без rate-limit (bcrypt 60-80мс тормозит,
  но локаута нет) · токен в WS query попадает в access-логи
  прокси — trade-off браузерного WebSocket, TLS+TTL 7d ·
  токен в
  localStorage — читаем любым XSS (стандарт SPA, httpOnly-cookie
  потребует CSRF-слоя — отдельное решение).

## T-27 · Line endpoints + arrow nudge · `review` · XS
Закрыта реальная UX-дыра (не выдуманная фича): нарисованную линию
нельзя было изменить — теперь 2 endpoint'а драгабельны. Стрелки
наджут на 1wu (Shift=10) для любого выделения — стандарт редактора.
Оба undo-aware.

## T-28 · Layers panel · `review` · S
Поверхность «найти объект» — по 10k объектов кликом не попадёшь.
Панель z-sorted (верхний первым), клик по строке → select + zoom
к объекту. Край: список — снапшот на момент рендера, без подписки
на модель; прилетевший op при открытой панели сам не обновит
список (переоткрытие решает).

## T-35 · Group tags · `review` · S
Flat `group`-prop (модель из дизайна auth-дока, юзер выбрал «по
тегам» — дерева нет и не будет). Ctrl+G тегает mutable-выделение
общим `g-xxx`, Ctrl+Shift+G снимает. Клик/shift-клик на объекте с
тегом расширяет выделение на весь тег (unit-toggle). Undo-aware,
null-проп = снятие. Marquee/ctrl+A тоже group-aware (любой член
тянет весь тег; locked-члены остаются невидимыми для селекта по
T-38). Края честно: вход внутрь группы (isolation) и вложенность —
вне скоупа по дизайну; locked не тегаются, но lock-член уже в
теге остаётся сгруппированным по клику (в жест не едет —
orig-фильтр).

## T-32 · Doc delisting · `review` · XS
DELETE /docs/{id} removes id from the discovery Set only —
journal/snapshot untouched, re-join re-adds (reversible, no destroy
semantics without auth). Client: `unlist` button next to the picker.
Verified live: DELETE -> 204, id gone from /docs.

## T-33 · Align-команды · `review` · S
Alt+arrows — align к крайней грани выделения; Alt+H/Alt+V — центры.
Box-kinds only (у line/path нет x/y-якоря); выравнивание по AABB —
для rot≠0 quad'а, что визуально корректно. Undo-aware. Distribute
тоже сделан (Alt+Shift+H/V — равные гэпы, крайние якорятся, `1ba0c3c`).

## T-34 · Multi-select group resize · `review` · S
Один BR-хендл на union-box при size>=2; scale TL-anchored,
per-axis (Shift=uniform), clamp 0.05/1wu min. Только box-kinds —
line/path не участвуют (нет x/y/w/h). Commit через общий жест-
путь (одна undo-запись). Край: масштабируются x/y/w/h, rot не
сохраняет пропорцию вокруг группового центра (упрощение).

## T-35 · Group rotate · `review` · S
Shift+драг за BR-хендл группы: каждый объект крутится вокруг центра
union-bbox; boxes копят свой rot, line/path — point-wise спин
(rot-пропа у них нет). Одна undo-запись на жест. Край: box спин
идёт по AABB-центру (=центру quad'а — верно); text-поворот
копит rot, но glyphs не растягиваются — поведение честное.

## T-36 · Rotate handle + Alt-resize · `review` · S
9-я точка над верхней гранью = rotate без Shift (single и group),
Shift+BR сохранён для совместимости. Alt при resize теперь реально
масштабирует от центра (computeResize `center` — хинт в `?` раньше
врал: alt не был подключён). История: первый коммит T-36 уронил `}`
в handlePoints и собирался сломанным — починено `1d79184`.

## T-37 · Inspector · `review` · S
Числовой ввод x/y/w/h/rot (+fontSize у text) для single box-selection
(панель снизу справа, коммит на blur/Enter). Через Editor.applyProps
— undo-aware Patch на проводе, как драг. Line/path не показываются
(нет x/y/w/h); multi-select — только счёт, полей нет. key=`id:k:v` —
инпуты перемонтируются на remote-изменении (раньше показывали
протухшие числа навсегда).

## T-38 · Locking · `review` · S
Ctrl+Shift+L — toggle lock (Figma: защита от случайных правок).
Locked: click-through в hitTest (клик падает на объект ниже),
marquee и Ctrl+A пропускают, хендлы не стартуют жест даже при
выделении через layers, group-move не тащит locked-sibling.
Unlock-путь — layers-панель (выделение по id минует hitTest) +
тот же хоткей; строка с 🔒 и приглушена. Края: group lock пишет
N undo-записей (по одной на объект — честно, но шумно); locked
объект всё ещё удаляем/двигаем remote-опами — lock локальный UX-
гейт, не permission.

## T-39 · Opacity · `review` · S
`opacity` prop (0–1) → globalAlpha в рендере; LWW мержится даром.
Inspector-поле для всех скалярных типов, шаг 0.05, кламп 0–1.
Край: path в inspector не показывается (массив точек), но prop
через wire применяется — честно.

## T-40 · Multi-inspector · `review` · S
Union-box панель при sel>=2: x/y-инпуты сдвигают всю группу
(общий Editor.translateBy с arrow-nudge — одна undo-запись),
w·h read-only (scale-ввод = отдельный шаг, честно пропущен).

## T-41 · Layers drag-reorder · `review` · S
Строки layers-панели draggable; drop ставит объект на fractional-z
под целевой строкой (список z-desc → between(next.z, row.z), last
row → before). Undo-aware Reorder, locked-dragged гейтится в
reorderTo. Край: визуального drop-индикатора нет — drop-позиция
видна по результату, честный MVP.

## T-42 · Copy/paste · `review` · S
Ctrl+C пишет JSON выделения (kind=cc-objects), Ctrl+V читает и
создаёт у позиции курсора (единый union-якорь — группа не слипается
в точку). Чужой буфер игнорится молча, кап 200 объектов на вставку,
empty-selection copy не затирает буфер. Locked не копируется
(mutable()); копия несёт locked-проп — честно. Paste без
mouseMove — fallback на место копии +24 (не в world (0,0)).

## T-36 · Image blobs · `review` · M
Redis-blob MVP (одно хранилище, без нового сервиса): `blob:{id}` +
`blob:{id}:meta`, капы 5MB/50-на-док, типы png/jpeg/webp/gif.
POST editor+; GET member-или-grant (img не шлёт хедеры → token/
grant в query). CallerRole получил grant-вектор, member>link>
legacy — пойман и починен баг: viewer-линк даунгрейдил бы члена.
Рендерер: кэш, load-once, плейсхолдер, dirty-on-load; upload-
кнопка → insertImage в центр вьюпорта с аспектом. Края честно:
нет malware-скана, нет очистки блобов при удалении объекта/дока
(утечка по капу), кап 50 — мягкий (check-then-act: два параллельных
upload пролезут оба → 51), Redis-память за блобы — до S3/диска масштаб.
Плюс закрыта дыра из T-26: /auth/login throttle 8/10мин → 429.

## T-43 · Link expiry · `review` · XS
Bearer-линки больше не обязаны жить вечно: `ttlHours` 1..720 на
минте (POST /links), хранится `role|expiryUnix`, истёкший грант
лениво самоудаляется при первом касании (и LinkRoleAsync, и
LinksAsync). Линки без ttl — бэк-совместимы (значение без пайпа).
UI: поле «exp h» в share-панели, пусто = навсегда (подписано).
Бот: mint с ttl, 400 на out-of-range, expired-грант посеян прямо
в Redis и отказан на join (API клампит ≥1ч — ждать нельзя).
Край: истёкшие гранты висят в хеше до первого чтения — sweep'а нет.

## T-44 · Link list + revoke UI · `review` · XS
Share-панель показывает живые гранты (GET /links): роль · обрезанный
токен · copy-URL · kill (DELETE /links/{token}). До этого линк после
копирования слепнул — отозвать было нечего смотреть. Минт перезагружает
список. Коммит `1de4535`. Листинг несёт `{role,exp}` — панель показывает
⏳-дедлайн у ttl-линков (`ddff024`).

## T-45 · Hard delete дока · `review` · S
`DELETE /docs/{id}?hard=1` — owner-only, необратимо: members, links,
meta, журнал, снапшот, owner-claim, ВСЕ blob-ключи (закрывает часть
blob-GC), индексы docs/owned:docs/user:*:docs. Tombstone
`doc:{id}:dead` блокирует воскрешение через legacy-open ветку —
проверяется первой в CallerRole и EffectiveRole. Живые сокеты
теряют права на следующем op (per-op recheck). UI: destroy doc в
share-панели owner'а с confirm. Коммит `1de4535`. Бот: 9 чеков.
Край: tombstone-ключи копятся по одному на удалённый док — sweep
не нужен, но факт задокументирован.

## T-46 · Ownership transfer · `review` · XS
`POST /docs/{id}/owner {login}` — только owner, цель = существующий
не-owner член (незнакомцу/линку отдать нельзя). Бывший owner падает
в admin — права на управление остаются, destroy/transfer уходят.
UI: кнопка own у member-строки. Коммит `8dfbad8`. Бот: 4 чека.

## T-47 · Password change · `review` · XS
`POST /auth/password {old,new}` — Bearer, verify old → rehash →
убивает ВСЕ сессии кроме текущей (утёкший токен умирает с паролем).
Индекс `user:{id}:sess` — set живых токенов, пишется в NewSession,
чищается в Logout. UI: кнопка pass → два prompt. Коммит `8dfbad8`.
Бот: 6 чеков (tok2 умирает, tok1 живёт, старый пароль 401).
Край: токены, минтованные до индекса, сет не видит — самоисправится.

## T-48 · Doc comments · `review` · M
Комменты — НЕ doc-state: `doc:{id}:comments` hash, без LWW/журнала/
undo (разговор, не канвас). Hub `AddComment` (editor+, cap 500×1000)
+ `DeleteComment` (автор или admin+, чужое молча 404-эквивалентно),
бродкаст `comment` add/del на группу. REST GET для бэклога (viewer+).
Гость на edit-линке = `guest·conn6`. UI: chat-кнопка + панель с
Enter-send. Коммит `c2e8c65` + бот-фикс `3b6823c`. Бот: 11 чеков.
Гость удаляет СВОЮ строку — автор матчится по той же
`guest·conn6`-идентити, что штампует AddComment (`ddff024`);
край: реконнект минтит новый connId → старые строки гостя
становятся чужими (ephemeral-идентити, честно).
Край: destroy чистит comments-ключ (в DestroyAsync).

## T-49 · Group isolation · `review` · S
Dblclick по члену группы → `editor.isolated=tag`: pick/hitTest,
marquee, Ctrl+A видят только членов тега; tag-expansion клика
выключена (член = индивидуален внутри). Чужие объекты dimmed 0.22
(renderer getIsolation). Выход: Esc / dblclick в пустоту / ungroup /
ленивая проверка «тег умер». Коммит `1f83e84`. Клиентская логика —
бот не покрывает; край: чужой объект над членом блокирует клик
(topmost wins, как в Figma).

## T-50 · Co-typing · `review` · XS
Кейстрок в textarea = живой `session.submit('Patch')` вместо
applyLocal — оптимистичный local+wire в одном вызове, никакой
новой механики (dedup/replay/rate-limit уже на месте). Escape-реверт
теперь тоже едет по проводу — локальный реверт расходился с сервером.
Whole-string LWW: два пишущих в одно поле → last-write, не per-char
(документировано; CRDT = другая операционная модель). Коммит `a4d1ef9`.
Край: 1 op на кейстрок — при 15 зн/с и 120/s лимите запас честный.

## T-51 · Touch: pointer events + pinch · `review` · S
onMouse* → onPointer* (мышь/перо/палец едино). Один палец = жест
активного инструмента; второй палец → pinch: zoom по отношению
дистанций в midpoint + pan по дельте midpoint. setPointerCapture
на канвасе. `touch-action:none` уже стоял. Panning-мышь (middle/
space) сохранена. Коммит `fe431ed`. Бот не покрывает (UI-слой).
Узкие экраны ≤760px (`ddff024`): header в wrap, кнопки/панели
мельче, stats прячется. Край: desktop-first всё равно — на очень
узких панели налезают друг на друга.

## T-52 · Blob GC + атомарная квота + распил эндпоинтов · `review` · S
Две задокументированные дыры закрыты и один архитектурный долг.
Квота 50/док: Lua-скрипт делает SCARD+SET+HSET+SADD атомарно —
параллельные upload больше не пролезают оба (был check-then-act).
GC: `WriteSnapshot` вызывает `SweepBlobs` — blob'ы, не видимые ни
в одном `props.src` снапшота И старше 120с (grace на upload→Create
гонку), удаляются. Destroy дока сносит blob-ключи сразу (T-45).
Бот: древний сирот 404, свежий сирот 200 (grace), referenced 200.
Архитектура: `Program.cs` 560 → 65 строк composition root; новый
`Endpoints/` — Auth/Doc/Blob модули + общий `Authz` (HTTP-твин
EffectiveRole — один порядок ролей, два входа). Коммит `57b516a`.
Край: сирота младше 120с переживает один свип — собирается на
следующем (каждые 100 опов); destroy — единственный мгновенный путь.
