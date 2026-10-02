# Размещение «Морского боя» на asolontsov.ru — ручной деплой

Схема под ваш текущий nginx (nginx на хосте, все сервисы через `localhost`):

```
https://asolontsov.ru/sea-battle.html    -> ВАШЕ приложение на 8081 (файл в папке сайта)
https://asolontsov.ru/sea-battle/styles.css  ┐
https://asolontsov.ru/sea-battle/game.js     ├-> nginx срезает /sea-battle/ -> 127.0.0.1:8102 -> контейнер
wss://asolontsov.ru/sea-battle/ws            ┘   (backend видит /styles.css, /game.js, /ws)
```

Ключевое: страница лежит **внутри контейнера сайта** и отдаётся вашим
приложением, а ассеты и WebSocket идут в бэкенд-микросервис по префиксу
`/sea-battle/`. Эти пути не пересекаются, поэтому приложение менять не нужно —
достаточно положить один файл. CORS не нужен: домен один.

Порт 8102 свободный (заняты 22,53,68,80,443,3000,3001,5433,8000,8002,
8081-8085,8087-8091,8093,8095,8101).

Порядок работ — 4 шага, каждый можно делать отдельно.

---

## Шаг 1. Забрать файлы на сервер

Из репозитория игры нужны 3 файла:

| Файл | Назначение |
|---|---|
| `Dockerfile` | сборка образа |
| `docker-compose.yml` | запуск контейнера |
| `deploy/nginx/sea-battle-location.conf` | блок для вставки в nginx |

Плюс сама страница — её нужно собрать на своей машине:

```bash
node scripts/build-site-bundle.mjs  # -> dist/sea-battle.html (~464 КБ, один файл)
```

Копирование на сервер:

```bash
cd путь/к/game-sea-battle
scp Dockerfile docker-compose.yml deploy/nginx/sea-battle-location.conf USER@СЕРВЕР:/tmp/
scp dist/sea-battle.html USER@СЕРВЕР:/tmp/sea-battle.html
```

## Шаг 2. Поднять бэкенд

На сервере:

```bash
ss -ltn | grep 8102        # порт должен быть свободен
mkdir -p ~/sea-battle && cd ~/sea-battle
mv /tmp/Dockerfile /tmp/docker-compose.yml .

docker compose up -d --build
docker compose ps            # статус должен быть healthy
curl -s http://127.0.0.1:8102/healthz
```

Ожидаемый ответ: `{"ok":true,"service":"sea-battle",...}`

Если нужен другой порт — поменяйте в `.env`:

```bash
echo "SEA_BATTLE_HOST_PORT=8102" > .env
echo "SEA_BATTLE_ALLOWED_ORIGINS=https://asolontsov.ru,https://www.asolontsov.ru" >> .env
```

Без compose (одной командой):

```bash
docker build -t sea-battle-backend:1.0.0 .
docker run -d --name sea-battle-backend --restart unless-stopped \
  -p 127.0.0.1:8102:3000 \
  -e NODE_ENV=production \
  -e ALLOWED_ORIGINS=https://asolontsov.ru,https://www.asolontsov.ru \
  --memory 256m \
  sea-battle-backend:1.0.0
```

## Шаг 3. Положить страницу в папку сайта (внутрь контейнера)

Узнайте имя контейнера сайта (тот, что на порту 8081):

```bash
docker ps --format '{{.Names}}\t{{.Ports}}' | grep 8081
```

Найдите папку, из которой сайт отдаёт файлы. Сначала посмотрите, что примонтировано
(если папка сайта — это bind mount, копировать надо на хост, внутрь контейнера не нужно):

```bash
docker inspect <контейнер-сайта> --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

Если в списке есть что-то вроде `.../www -> /var/www/html` — это ваш веб-корнь
на хосте. Тогда:

```bash
cp /tmp/sea-battle.html /путь/на/хосте/из/mounts/sea-battle.html
```

Если папки сайта среди mounts нет, она внутри образа — ищите и копируйте через docker:

```bash
# найти каталог с index.html / index.php
docker exec <контейнер-сайта> sh -c \
  'find / -maxdepth 4 \( -name "index.php" -o -name "index.html" \) -not -path "*/node_modules/*" 2>/dev/null | head -5'

# положить рядом с ним (пример для /var/www/html)
docker cp /tmp/sea-battle.html <контейнер-сайта>:/var/www/html/sea-battle.html
docker exec <контейнер-сайта> ls -la /var/www/html/sea-battle.html
```

Права на файл: `docker exec <контейнер-сайта> chown www-data:www-data /var/www/html/sea-battle.html`
(подставьте пользователя вашего приложения) и `chmod 644`.

Если после копирования страница не открывается (приложение отдаёт свою 404
на неизвестные файлы) — вернитесь к шагу 4 и добавьте в nginx блок
`location = /sea-battle.html { root /var/www/sea-battle; }`, положив файл на хост.

## Шаг 4. Вставить блок в nginx

Откройте файл с вашим `server { server_name asolontsov.ru ... }`
(обычно `/etc/nginx/sites-enabled/asolontsov.ru` или `conf.d/...`).

Вставьте **всё содержимое** `deploy/nginx/sea-battle-location.conf` внутрь
этого `server` — рядом с `location /` (сайт на 8081). Это единственное
изменение в nginx.

Проверка и перезагрузка:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` должен сказать `syntax is ok` / `test is successful`. Если ругается —
ничего не перезагружайте, пришлите вывод.

## Шаг 5. Проверить

```bash
curl -sI https://asolontsov.ru/sea-battle.html | head -3
curl -sI https://asolontsov.ru/sea-battle/game.js  | head -3
curl -s  https://asolontsov.ru/sea-battle/healthz
```

Ожидается: `200` для страницы и `game.js`, для `healthz` — JSON.

В браузере на https://asolontsov.ru/sea-battle.html:

1. «Играть с компьютером» — бой с ботом, сервер не нужен.
2. «Играть по сети» → статус **«Соединение установлено»**.
3. «Создать комнату» → 5-символьный код.
4. Второй клиент (с телефона) → «Играть по сети» → ввод кода → бой.
5. В консоли браузера ошибок нет.

---

## Если что-то пошло не так

**WebSocket не подключается, в консоли 403 или «Подключение…» не меняется.**
Не совпал `Origin`. В `ALLOWED_ORIGINS` домен должен быть ровно такой, какой
его видит браузер: со `https://`, без слэша в конце, без порта. Проверить:

```bash
docker logs --tail 20 sea-battle-backend
docker exec sea-battle-backend printenv ALLOWED_ORIGINS
```

**404 на `/sea-battle/game.js`.** Проверьте хвостовой слеш в `proxy_pass`:
должно быть `http://127.0.0.1:8102/`. Со слешем nginx срезает префикс
`/sea-battle/`, без слеза бэкенд получает `/sea-battle/game.js` и не найдёт.

**502 на `/sea-battle/*`.** Контейнер не поднялся или занят другой порт:

```bash
docker compose ps
docker compose logs --tail 50
ss -ltn | grep 8102
```

**Страница открывается, а стилей нет / белый фон.** Стили лежат по адресу
`/sea-battle/styles.css`. Проверьте, что в блоке страницы
`<link ... href="/sea-battle/styles.css">` и что в логе nginx нет 404 на `.css`.

**Игра грузится на компьютере, но не на телефоне.** Проверьте в DevTools
вкладку Network: запрос `wss://asolontsov.ru/sea-battle/ws` должен иметь
статус `101 Switching Protocols`. Если соединение идёт на `ws://` — значит
страница открыта по http, а не по https.

**Запустили вторую копию бэкенда.** Комнаты живут в памяти процесса:
воиду в другую копию попасть нельзя, нужны Redis или sticky sessions.

**Обновить игру.** Пересобрать фронт и перезалить:

```bash
node scripts/build-site-bundle.mjs
scp dist/sea-battle.html USER@СЕРВЕР:/путь/в/репозиторий/сайта/html/games/sea-battle.html
```

Страница отдаётся с `Cache-Control: no-cache`, игра при этом кэшируется
час (`maxAge: 1h` в Express) — если нужен сброс кэша ассетов, добавьте
в `location /sea-battle/` строку `proxy_hide_header Cache-Control;`.
