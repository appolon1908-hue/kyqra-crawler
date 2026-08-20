#!/usr/bin/env bash
set -euo pipefail

# This script is invoked only by the fixed-path privileged installer. It does
# not accept paths or commands from users.
exec /usr/local/sbin/codestra-kyqra-remediation-admin rollback
