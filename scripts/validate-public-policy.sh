#!/usr/bin/env bash
set -euo pipefail

node --test test/policy.test.mjs
echo 'PUBLIC_ROUTE_POLICY_TESTS=PASS'

