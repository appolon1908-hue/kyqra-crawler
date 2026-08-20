#!/usr/bin/env bash
set -euo pipefail

file=config/nginx/kyqra-private-mtls.conf.template
grep -Fq 'listen 10.40.0.4:18444 ssl;' "$file"
grep -Fq 'server_name kyqra.internal.codestra.agency;' "$file"
grep -Fq 'ssl_verify_client on;' "$file"
grep -Fq '^CN=middleware-kyqra-client$' "$file"
grep -Fq 'ssl_client_serial' "$file"
grep -Fq 'ssl_protocols TLSv1.2 TLSv1.3;' "$file"
grep -Fq 'proxy_pass http://127.0.0.1:3100;' "$file"
echo 'MTLS_CONFIGURATION_TESTS=PASS'

