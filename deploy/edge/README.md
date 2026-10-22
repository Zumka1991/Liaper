# Развёртывание на liaper.ru

Сервер `191.215.45.93` общий: порты 80/443 держит edge-Caddy из `/opt/edge`,
проекты подключаются к нему через Docker-сеть `edge` (см. `/opt/edge/README.md`).

- `/opt/liaper` — копия репозитория, `.env` с секретами (chmod 600), `compose.override.yaml` отсюда.
- `/opt/edge/sites/liaper.ru.caddy` — маршрут сайта отсюда.
- В `.env`: `LIAPER_TRUSTED_PROXY_HOPS=2` (edge + nginx контейнера web).

Обновление:

```bash
git archive HEAD | ssh root@191.215.45.93 "tar -x -C /opt/liaper"
ssh root@191.215.45.93 "cd /opt/liaper && cp deploy/edge/compose.override.yaml . && docker compose up -d --build"
```

Маршрут edge (после изменения файла):

```bash
scp deploy/edge/liaper.ru.caddy root@191.215.45.93:/opt/edge/sites/
ssh root@191.215.45.93 "cd /opt/edge && docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile"
```
