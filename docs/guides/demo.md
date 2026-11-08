# Demo scenario — CollabCanvas

Goal: show a REAL multiplayer conflict and the system's guarantees,
not just "two windows show the same picture".

## Setup

`docker compose up --build` → two browsers on `localhost:3100`
(или `npm run dev` :5173). Join demo в обоих. Второй юзер = второй
clientId — видно по цвету курсора.

## Act 1 — базовый мультиплеер

1. A рисует rect (tool `r`), драгает — B видит движение (patch'и по
   80мс), курсор A с именем.
2. B тянет тот же rect в другую сторону → franken-merge на глазах:
   последний дошедший до сервера patch выигрывает, обе стороны
   сходятся (§12.1 — это фича LWW, не баг).

## Act 2 — гарантии при сбоях

3. **Reconnect:** у B вырубить сеть (DevTools → offline), A делает
   5 правок, B возвращается → автоматический rejoin с lastSeq →
   хвост ops долетает, сцена совпадает. Показать `seq` в статах до
   и после.
4. **Server restart:** `docker compose restart api` → оба клиента
   реконнектятся (jitter-backoff) → join даёт snapshot+tail → до ~1с
   ops могло потеряться (AOF everysec — честно, §9). Документ цел —
   журнал в Redis пережил процесс API.
5. **Dedup:** A драгает, рвёт сеть посреди submit → клиентский
   pending rebase'ит после rejoin; серверный `_ackIndex` возвращает
   исходный seq — дубля в журнале нет (проверка: повторный SubmitOp
   → `IsNew=false`).

## Act 3 — scale-out (опционально, 2 инстанса API)

6. Поднять api на другом порту с тем же Redis → клиенты на разных
   инстансах редактируют один doc: owner claim виден в Redis
   (`GET doc:demo:owner`), submit non-owner'а летит через `doc:in`.

## Act 4 — perf

7. **Stress 10k** → pan/zoom: stats overlay показывает
   `drawn << objects` (quadtree culling работает), fps/drawMs —
   критерий 60fps оценивается глазами (автоматики нет — честно).

## Что спросить у демонстратора (ворота)

- Где в этом сценарии op может продублироваться? (сеть, pub/sub,
  retry) — и почему ни один путь не даёт двойного применения.
- Где может потеряться? (kill mid-append, pub/sub at-most-once,
  claim loss) — и что каждое делает видимым.
