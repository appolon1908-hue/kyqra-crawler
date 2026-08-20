#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
manifest="$root_dir/release/kyqra-mtls-staging-20260820.json"
workflow="$root_dir/.github/workflows/sign-kyqra-release.yml"

test "$(jq -r .repository "$manifest")" = "appolon1908-hue/kyqra-crawler"
test "$(jq -r .source_commit "$manifest")" = "a9d59681a7857795adc086d2464859674901e393"
test "$(jq -r .registry_digest "$manifest")" = "sha256:1d918aa99ce19a7831baafdf428f3323abf8134472c2a5f202a60a84181e15e0"
test "$(jq -r .linux_amd64_platform_digest "$manifest")" = "sha256:b5ad0fe7aed3d7de20e882d8f84295485b4d85c2ab54229895e46689fdf4484e"
test "$(jq -r .required_workflow "$manifest")" = ".github/workflows/sign-kyqra-release.yml"
test "$(sha256sum "$workflow" | cut -d' ' -f1)" = "$(jq -r .signing_workflow_sha256 "$manifest")"
test "$(grep -Ec '^  workflow_dispatch:$' "$workflow")" = 1
! grep -Eq '(^|[[:space:]])inputs:' "$workflow"
! grep -Eq 'pull-requests:[[:space:]]*write|contents:[[:space:]]*write|issues:[[:space:]]*write' "$workflow"
! grep -Eq 'attestations:[[:space:]]*write|artifact-metadata:[[:space:]]*write' "$workflow"
test "$(grep -Ec 'uses: [a-z0-9-]+/[a-z0-9-]+@[0-9a-f]{40}$' "$workflow")" = 3
test "$(grep -Fc 'sha256:1d918aa99ce19a7831baafdf428f3323abf8134472c2a5f202a60a84181e15e0' "$workflow")" = 4
grep -Fq 'cosign sign --yes "$IMAGE"' "$workflow"
grep -Fq 'cosign attest --yes --type slsaprovenance1' "$workflow"
grep -Fq 'cosign verify-attestation --type slsaprovenance1' "$workflow"
grep -Fq 'cosign attest --yes --type spdxjson' "$workflow"
grep -Fq 'https://token.actions.githubusercontent.com' "$workflow"
