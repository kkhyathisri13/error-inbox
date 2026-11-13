import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
test('CI validates all supported Node majors with actual lint/test commands', async () => {
  const workflow = await read('.github/workflows/ci.yml');
  const manifest = JSON.parse(await read('package.json'));
  for (const major of [22, 24, 26]) {
    assert.ok(workflow.includes(`'${major}.x'`));
    assert.ok(manifest.engines.node.includes(`^${major}.`));
  }
  assert.match(workflow, /npm ci --ignore-scripts/u);
  assert.match(workflow, /npm run lint/u);
  assert.match(workflow, /npm run test:coverage/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /ubuntu-24\.04/u);
  assert.doesNotMatch(workflow, /continue-on-error:\s*true/u);
  assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0);
  assert.equal(Object.keys(manifest.devDependencies ?? {}).length, 0);
});
test('all external actions are pinned and checkout never persists credentials', async () => {
  for (const name of ['ci.yml', 'project-stats.yml']) {
    const workflow = await read(`.github/workflows/${name}`);
    const uses = [...workflow.matchAll(/uses:\s*(\S+)/gu)].map(match => match[1]);
    assert.ok(uses.length >= 2);
    for (const action of uses) assert.match(action, /^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/u);
    assert.match(workflow, /^permissions:\n  contents: read$/mu);
    assert.match(workflow, /persist-credentials: false/u);
    assert.doesNotMatch(workflow, /^\s*(?:pull_request_target|workflow_run):/mu);
  }
});
test('statistics writes are default-branch-only, narrowly scoped, and never auto-merged', async () => {
  const workflow = await read('.github/workflows/project-stats.yml');
  assert.match(workflow, /if: github\.ref == format\('refs\/heads\/\{0\}'/u);
  assert.match(workflow, /cron: '23 6 \* \* 1'/u);
  assert.match(workflow, /add-paths: PROJECT_STATS\.md/u);
  assert.match(workflow, /branch: automation\/project-stats/u);
  assert.match(workflow, /delete-branch: false/u);
  assert.match(workflow, /pull-requests: write/u);
  assert.match(workflow, /actions: write/u);
  assert.match(workflow, /gh workflow run ci\.yml --ref automation\/project-stats/u);
  assert.doesNotMatch(workflow, /gh pr merge|enable-pull-request-automerge|pull_request:/u);
});
test('lockfile matches the private dependency-free manifest', async () => {
  const manifest = JSON.parse(await read('package.json'));
  const lock = JSON.parse(await read('package-lock.json'));
  assert.equal(manifest.private, true);
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.deepEqual(Object.keys(lock.packages), ['']);
  assert.deepEqual(lock.packages[''].engines, manifest.engines);
});
