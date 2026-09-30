# Контекст проекта

## Цель
Морской бой для Яндекс Игр: режим против бота + сетевой режим (WS-сервер с комнатами).

## Архитектура
- `server.mjs` — Express (статика `public/`, `/healthz`) + WebSocketServer на `/ws`.
  Комнаты в памяти (`rooms` Map), сессии (`sessions`), очередь быстрого поиска (`quickQueue`).
- `public/shared/rules.mjs` — общие для клиента и сервера правила: флот, `applyAttack`,
  `isFleetDestroyed`, `chooseBotTarget`, `createRandomFleet`. ESM, работает и в Node, и в браузере.
- `public/game.js` — весь клиент (рендер на canvas, бот, сетевой режим).
- `public/platform.js` — обёртка над Яндекс SDK (реклама, фуллскрин), деградирует без SDK.
- `public/config.js` — рантайм-конфиг (`SEA_BATTLE_CONFIG`): `serverUrl`, реклама.

## Протокол WS (`/ws`)
Клиент -> сервер: `hello{token}` (hex 16..80, обязателен первым), `join{action:create|join|quick|reconnect, code}`,
`place{fleet}`, `fire{x,y}`, `rematch`, `leave`.
Сервер -> клиент: `waiting{code}`, `queued`, `state{...}`, `placementAccepted`, `roomClosed`, `error{code,message}`.

### Важно: семантика `boards` в `state`
`player.attacks` — выстрелы, полученные этим игроком (т.е. сделанные соперником).
Поэтому `boards.self.attacks` = выстрелы **по моей** доске, `boards.opponent.attacks` = **мои** выстрелы.
Клиент обязан маппить инверсно (см. game.js ~1838).

## Текущая задача
Протестировать игру, запустить локально, обеспечить игру по внутренней сети. — Выполнено 2026-09-30.

## Ключевые файлы
- `server.mjs:50` `isOriginAllowed` — проверка Origin для WS (в prod жёсткая, в dev + приватные подсети).
- `server.mjs:375` `stateForPlayer` — формирование состояния комнаты.
- `server.mjs:774` `handleFire` — серверная валидация выстрела.
- `public/game.js:1838` — маппинг выстрелов из сетевого состояния.
- `public/game.js:2869` — выбор списка выстрелов для отрисовки доски.
- `tests/rules.test.mjs` — юнит-тесты правил.