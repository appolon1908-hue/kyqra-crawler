#!/bin/sh
set -eu
docker compose -f /opt/kyqra-crawler/docker-compose.yml exec -T postgres psql -U crawler -d crawler -c "DELETE FROM jobs WHERE created_at < now() - interval '30 days'; VACUUM ANALYZE;"
