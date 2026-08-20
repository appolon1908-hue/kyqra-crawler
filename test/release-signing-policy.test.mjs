import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const manifest = JSON.parse(fs.readFileSync('release/kyqra-mtls-staging-20260820.json', 'utf8'));
const workflow = fs.readFileSync('.github/workflows/sign-kyqra-release.yml', 'utf8');

test('release identity and digests are immutable', () => {
  assert.equal(manifest.repository, 'appolon1908-hue/kyqra-crawler');
  assert.equal(manifest.source_commit, 'a9d59681a7857795adc086d2464859674901e393');
  assert.equal(
    manifest.registry_digest,
    'sha256:1d918aa99ce19a7831baafdf428f3323abf8134472c2a5f202a60a84181e15e0',
  );
  assert.equal(
    manifest.linux_amd64_platform_digest,
    'sha256:b5ad0fe7aed3d7de20e882d8f84295485b4d85c2ab54229895e46689fdf4484e',
  );
});

test('workflow exposes no digest or commit override', () => {
  assert.match(workflow, /workflow_dispatch:\s*\n/);
  assert.doesNotMatch(workflow, /\n\s+inputs:/);
  assert.doesNotMatch(workflow, /pull-requests:\s*write|contents:\s*write|issues:\s*write/);
  assert.doesNotMatch(workflow, /attestations:\s*write|artifact-metadata:\s*write/);
});

test('workflow pins protected ref, tag, source and registry subjects', () => {
  assert.match(workflow, /refs\/heads\/main/);
  assert.match(workflow, /kyqra-mtls-staging-20260820\^\{commit\}/);
  assert.match(workflow, /a9d59681a7857795adc086d2464859674901e393/);
  assert.match(workflow, /sha256:1d918aa99ce19a7831baafdf428f3323abf8134472c2a5f202a60a84181e15e0/);
});

test('private-repository fallback pins Cosign OIDC identity', () => {
  assert.match(workflow, /cosign sign --yes "\$IMAGE"/);
  assert.match(workflow, /cosign attest --yes --type slsaprovenance/);
  assert.match(workflow, /cosign attest --yes --type spdxjson/);
  assert.match(workflow, /https:\/\/token\.actions\.githubusercontent\.com/);
  assert.match(workflow, /sign-kyqra-release\.yml@refs\/heads\/main/);
});

test('provenance is a SLSA v1 predicate', () => {
  const provenance = JSON.parse(
    fs.readFileSync('release/evidence/final-image-provenance.json', 'utf8'),
  );
  assert.ok(provenance.buildDefinition);
  assert.ok(provenance.runDetails?.builder?.id);
  assert.equal(provenance.buildDefinition.externalParameters.sourceCommit, manifest.source_commit);
  assert.equal(
    provenance.buildDefinition.externalParameters.registryDigest,
    manifest.registry_digest,
  );
});
