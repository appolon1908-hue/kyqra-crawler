#!/usr/bin/env bash
set -euo pipefail

export KYQRA_IMAGE='ghcr.io/appolon1908-hue/kyqra-crawler@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export POSTGRES_PASSWORD='fixture-only-not-a-production-secret'
export KYQRA_ENV_FILE='test/fixtures.env'
export KYQRA_SERVICE_PRINCIPALS_FILE='test/fixtures-service-principals.json'
export KYQRA_SECRETS_GID='65534'
docker compose -f docker-compose.yml config --quiet
rendered=$(docker compose -f docker-compose.yml config)
grep -Fq 'host_ip: 127.0.0.1' <<<"$rendered"
grep -Fq 'published: "3100"' <<<"$rendered"
! grep -Eq 'published: "?(5432|6379)' <<<"$rendered"
! grep -Eq 'host_ip: (0\.0\.0\.0|10\.40\.0\.4)' <<<"$rendered"
echo 'DOCKER_COMPOSE_VALIDATE=PASS'
