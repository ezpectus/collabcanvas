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

## T-11 · Финиш: README + демо + perf · `todo` · S

**Devin пишет:** README (EN) — что это, архитектура одной
картинкой, как запустить, что доказано. Демо-сценарий. Perf-pass:
замер кадра и op-latency, узкие места в отчёт.

**Ревью-чеклист:** README отвечает «зачем и как работает» ·
демо показывает реальный мультиплеер-конфликт.

**Gate:** финальный прогон — объяснить путь op'а от мышки до
чужого экрана и назвать каждое место, где система может
обосраться.
