#!/bin/sh
set -eu
base=/opt/kyqra-crawler/backups
mkdir -p "$base"
docker compose -f /opt/kyqra-crawler/docker-compose.yml exec -T postgres pg_dump -U crawler crawler | gzip > "$base/crawler-$(date +%F-%H%M).sql.gz"
find "$base" -type f -name '*.sql.gz' -mtime +14 -delete
