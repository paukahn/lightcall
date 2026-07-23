# LightCall — руководство по деплою

Эфемерный P2P mesh видеосервис. Signaling — Node.js + `ws`, медиа — прямой P2P,
NAT traversal — STUN + coturn (TURN REST). Целевой хост: VPS 1 vCPU / 1GB.

---

## ⚠️ 0. Критично: HTTPS обязателен в проде

`getUserMedia` (камера/микрофон), `navigator.wakeLock` и `clipboard` работают
**только в secure context** — то есть по HTTPS (исключение — `localhost` при
локальной разработке). По голому `http://ваш-домен:3000` камера/микрофон
**не запросятся** ни в одном браузере.

Вывод: перед публичным доменом обязателен TLS-терминатор (реверс-прокси). Ниже —
готовый вариант на Caddy (авто-сертификаты Let's Encrypt). Nginx/Traefik тоже подойдут.

---

## 1. Предпосылки

- VPS с публичным IP, Docker + Docker Compose.
- Доменное имя, указывающее A-записью на IP VPS (нужно для TLS и для TURN).
- Открытые порты на файрволе VPS (см. §5).

---

## 2. Секреты и `.env`

Скопируйте пример и заполните:

```bash
cp .env.example .env
```

Сгенерируйте сильные секреты:

```bash
echo "ADMIN_TOKEN=$(openssl rand -hex 32)"
echo "TURN_SECRET=$(openssl rand -hex 32)"
```

Минимально обязательные переменные в `.env`:

| Переменная | Назначение | Пример |
|---|---|---|
| `ADMIN_TOKEN` | доступ к `/admin.html` | `openssl rand -hex 32` |
| `TURN_SECRET` | общий секрет Node ↔ coturn | `openssl rand -hex 32` |
| `TURN_URLS` | публичные адреса TURN | `turn:call.example.com:3478?transport=udp,turn:call.example.com:3478?transport=tcp` |
| `TURN_REALM` | realm coturn | `call.example.com` |

`TRUST_PROXY=true` — обязательно, если приложение стоит за реверс-прокси
(иначе rate-limit увидит один IP прокси вместо реальных клиентов).

> `TURN_SECRET` в `.env` используется дважды: Node читает его как env, а coturn —
> через интерполяцию `${TURN_SECRET}` в `command`. Оба берут из одного `.env` —
> значения обязаны совпадать.

---

## 3. TLS / реверс-прокси (Caddy) — готовый пример

Создайте `Caddyfile`:

```
call.example.com {
    reverse_proxy app:3000
}
```

Добавьте сервис в `docker-compose.yaml` (Caddy сам выпустит и продлит сертификат):

```yaml
  caddy:
    image: caddy:2-alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
    depends_on:
      - app
    restart: always

volumes:
  caddy_data:
```

После этого **уберите публикацию `3000:3000`** у сервиса `app` (пусть слушает только
во внутренней docker-сети), чтобы наружу торчал лишь TLS-порт Caddy.

Caddy проксирует и WebSocket (`wss://`) прозрачно — доп. настройки не нужны.

---

## 4. Настройка coturn

В `docker-compose.yaml` coturn запущен с `network_mode: host` и `--use-auth-secret`
(TURN REST). Убедитесь, что:

- `TURN_URLS` в `.env` указывает на **публичный домен/IP** VPS (не на `localhost`,
  не на имя docker-сервиса — адрес должен резолвиться у клиента в браузере).
- `DETECT_EXTERNAL_IP=yes` (уже задано) — coturn сам определит внешний IP.
- Диапазон relay-портов `TURN_MIN_PORT..TURN_MAX_PORT` (по умолчанию 49160–49200)
  открыт на файрволе по UDP.

### TLS/443 для TURN (для сетей, режущих весь UDP)

Раскомментируйте в `command` coturn строки `--tls-listening-port=5349`, `--cert`, `--pkey`
и смонтируйте сертификаты (можно переиспользовать выпущенные Caddy из тома `caddy_data`,
либо выдать отдельные). Добавьте в `TURN_URLS`:
`turns:call.example.com:5349?transport=tcp`.

---

## 5. Порты файрвола VPS

| Порт | Протокол | Назначение |
|---|---|---|
| 80, 443 | TCP | HTTP→HTTPS редирект и веб/`wss` через Caddy |
| 3478 | UDP + TCP | TURN/STUN |
| 5349 | TCP | TURN over TLS (если включён) |
| 49160–49200 | UDP | relay-порты coturn (`TURN_MIN_PORT..MAX_PORT`) |

Порт `3000` наружу **не открывать** — приложение доступно только через Caddy.

---

## 6. Сборка и запуск

```bash
docker compose build
docker compose up -d
docker compose ps
docker compose logs -f app
```

Логи — структурный JSON (одна строка на событие, с `connId`/`roomId`/`clientId`
для трассировки). В логах `app` должно быть:

```json
{"t":"...","level":"info","msg":"server_started","port":3000}
{"t":"...","level":"info","msg":"turn_ready","ttl":3600,"servers":["turn:..."]}
```

Если вместо `turn_ready` видно `{"level":"warn","msg":"turn_not_configured"}` —
не заданы `TURN_SECRET`/`TURN_URLS`.

---

## 7. Проверка (обязательные шаги)

**7.1. Health signaling-сервера**

```bash
curl -s https://call.example.com/api/ice-servers
```
Ожидаем JSON с массивом `iceServers`, где есть запись `turn:` с полями
`username` (unix-timestamp) и `credential` (base64). Docker healthcheck дергает
этот же эндпоинт — `docker compose ps` должен показывать `healthy`.

**7.2. Проверка TURN relay (ключевой шаг)**

Серверная проверка через `turnutils` (есть в образе coturn):

```bash
# username/credential возьмите из вывода 7.1
docker compose exec coturn turnutils_uclient -v -u <username> -w <credential> -p 3478 <публичный-IP>
```
Успех — рукопожатие с allocation прошло, пакеты relayed.

Браузерная проверка через WebRTC Trickle ICE:
1. Откройте `https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/`
2. Удалите дефолтные серверы, добавьте ваш `turn:...` + `username`/`credential` из 7.1.
3. «Gather candidates». **Должен появиться кандидат типа `relay`.** Нет `relay` →
   TURN не работает (проверьте порты/секрет/внешний IP).

**7.3. Реальный сквозной звонок**

Откройте `https://call.example.com` в двух разных сетях (например Wi-Fi и мобильный
4G с выключенным Wi-Fi) — это проверяет именно NAT-траверс, а не два клиента за одним NAT.
Создайте комнату в одном, войдите по ссылке в другом, одобрите вход. Убедитесь: видео/звук
идут, индикатор качества зелёный.

**7.4. Админка**

`https://call.example.com/admin.html` → введите `ADMIN_TOKEN` → видны активные комнаты
и метрики (RAM/соединения/uptime).

---

## 8. Мониторинг

- Метрики процесса — в реальном времени в админке (RSS, heap, число соединений/комнат).
- Опционально Telegram: задайте `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` — события
  комнат приходят в чат.
- Логи: `docker compose logs -f app`. Настройте ротацию Docker (`json-file` с
  `max-size`/`max-file`), чтобы логи не съели диск.

---

## 9. Откат (rollback)

Состояние комнат живёт только в RAM — терять/бэкапить нечего. Откат = вернуть
предыдущий образ:

```bash
docker compose down
git checkout <предыдущий-тег>
docker compose up -d --build
```

Активные звонки при рестарте контейнера прервутся (клиенты попытаются reconnect
30 с — успеют вернуться, если сервер поднялся быстро).

---

## 10. Типовые проблемы

| Симптом | Причина | Решение |
|---|---|---|
| Камера/микрофон не запрашиваются | Открыли по `http://` | Только HTTPS (§0, §3) |
| Звонок «висит на Connecting» между разными сетями | Нет `relay`-кандидата | Проверьте TURN (§7.2): секрет, порты, `TURN_URLS`=публичный адрес |
| В логах `⚠️ TURN не сконфигурирован` | Пустые `TURN_SECRET`/`TURN_URLS` | Заполнить `.env`, пересоздать: `docker compose up -d` |
| Rate-limit блокирует реальных юзеров | За прокси не выставлен `TRUST_PROXY` | `TRUST_PROXY=true` в `.env` |
| `turnutils_uclient` не находит allocation | UDP relay-порты закрыты на файрволе | Открыть `49160–49200/udp` |
| Все клиенты за одним NAT «работают», а из интернета нет | Тест не проверяет NAT | Тестировать из двух разных сетей (§7.3) |

---

## 11. CI (рекомендация)

Минимальный набор проверок перед сборкой образа:

```bash
npm ci
npm audit --audit-level=high
npx tsc --noEmit
node --check public/client.js
```
