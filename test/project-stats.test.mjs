import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectStats, renderStats, validateRepository, writeStats } from '../scripts/lib/project-stats.mjs';

const repository = 'acme/error-inbox';
const metadata = { full_name: repository, stargazers_count: 2, forks_count: 3, open_issues_count: 9 };
const response = (data, status = 200, headers = {}) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers });
function client({ contributors = [[]], pulls = [[]], repo = metadata } = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    const parsed = new URL(url);
    const page = Number(parsed.searchParams.get('page')) - 1;
    if (parsed.pathname.endsWith('/contributors')) return response(contributors[page] ?? []);
    if (parsed.pathname.endsWith('/pulls')) return response(pulls[page] ?? []);
    return response(repo);
  };
  return { fetchImpl, requests };
}
const fixture = () => ({ repository, stars: 2, forks: 3, openIssuesAndPullRequests: 9,
  openPullRequests: 2, contributors: [{ login: 'alice', contributions: 4 }] });

for (const input of [undefined, null, '', 'https://github.com/a/b', '../x', 'a/..', 'a/.', 'a/b/c', 'a/b?token=x', 'a/b#x', '-a/b', 'a/b\\x']) {
  test(`rejects unsafe repository identifier ${String(input)}`, () => assert.throws(() => validateRepository(input), TypeError));
}
test('accepts valid GitHub owner and repository names', () => {
  assert.equal(validateRepository('a-b/repo.name_1'), 'a-b/repo.name_1');
});
test('collects real metrics, excludes bots, deduplicates, and breaks ties deterministically', async () => {
  const mock = client({ contributors: [[
    { login: 'zoe', type: 'User', contributions: 2 },
    { login: 'alice', type: 'User', contributions: 2 },
    { login: 'Alice', type: 'User', contributions: 3 },
    { login: 'alice', type: 'User', contributions: 1 },
    { login: 'first', type: 'User', contributions: 8 },
    { login: 'build', type: 'Bot', contributions: 100 },
    { login: 'automation[bot]', contributions: 100 },
    { login: 'bob', type: 'User', contributions: 2 },
  ]], pulls: [[{ number: 2 }, { number: 3 }, { number: 2 }]] });
  const result = await collectStats(repository, { fetchImpl: mock.fetchImpl, token: 'fixture-only-token' });
  assert.deepEqual(result.contributors.map(x => [x.login, x.contributions]), [['first', 8], ['Alice', 3], ['bob', 2], ['zoe', 2]]);
  assert.equal(result.openPullRequests, 2);
  assert.equal(result.openIssuesAndPullRequests, 9);
  assert.equal(mock.requests[0].options.headers.Authorization, 'Bearer fixture-only-token');
  assert.equal(mock.requests[0].options.redirect, 'error');
  assert.ok(mock.requests.every(x => new URL(x.url).origin === 'https://api.github.com'));
  assert.ok(mock.requests[1].url.includes('per_page=100&page=1'));
});
test('allows unauthenticated reads without an Authorization header', async () => {
  const mock = client();
  await collectStats(repository, mock);
  assert.equal(Object.hasOwn(mock.requests[0].options.headers, 'Authorization'), false);
});
test('fully paginates both contributors and open pull requests, including exact page boundaries', async () => {
  const people = Array.from({ length: 101 }, (_, i) => ({ login: `user-${i}`, contributions: i, type: 'User' }));
  const pulls = Array.from({ length: 200 }, (_, i) => ({ number: i + 1 }));
  const mock = client({ contributors: [people.slice(0, 100), people.slice(100)], pulls: [pulls.slice(0, 100), pulls.slice(100), []] });
  const result = await collectStats(repository, mock);
  assert.equal(result.contributors.length, 101);
  assert.equal(result.openPullRequests, 200);
  assert.equal(mock.requests.filter(x => x.url.includes('/pulls?')).length, 3);
});
test('supports contributors 204 empty responses', async () => {
  const result = await collectStats(repository, { fetchImpl: async url => url.endsWith(repository) ? response(metadata) : response(null, 204) });
  assert.deepEqual(result.contributors, []);
  assert.equal(result.openPullRequests, 0);
});
for (const maxPages of [0, -1, 1.5, 1001, '2']) {
  test(`rejects invalid pagination budget ${maxPages}`, async () => assert.rejects(collectStats(repository, { maxPages }), RangeError));
}
test('refuses partial statistics at the pagination limit', async () => {
  const mock = client({ contributors: [Array.from({ length: 100 }, (_, i) => ({ login: `u${i}`, contributions: 1 }))] });
  await assert.rejects(collectStats(repository, { ...mock, maxPages: 1 }), /refusing to publish partial/u);
});
test('rejects malformed pages and mismatched repository responses', async () => {
  await assert.rejects(collectStats(repository, client({ repo: { ...metadata, full_name: 'wrong/repo' } })), /mismatched/u);
  await assert.rejects(collectStats(repository, client({ repo: null })), /mismatched/u);
  await assert.rejects(collectStats(repository, client({ contributors: [{}] })), /non-array/u);
});
for (const contributor of [{ login: 'bad|link', contributions: 1 }, { contributions: 1 }, { login: 'valid', contributions: -1 }, { login: 'valid', contributions: '1' }]) {
  test(`rejects invalid contributor data ${JSON.stringify(contributor)}`, async () => {
    await assert.rejects(collectStats(repository, client({ contributors: [[contributor]] })), /invalid|Invalid/u);
  });
}
test('rejects invalid metadata and PR counts rather than silently writing bogus stats', async () => {
  await assert.rejects(collectStats(repository, client({ repo: { ...metadata, forks_count: -1 } })), /fork count/u);
  await assert.rejects(collectStats(repository, client({ pulls: [[{ number: NaN }]] })), /pull request number/u);
});
test('survives case-normalized repository names', async () => {
  assert.equal((await collectStats('ACME/error-inbox', client())).repository, repository);
});
for (const status of [401, 404, 500, 301]) {
  test(`fails promptly on non-retryable HTTP ${status}`, async () => {
    let calls = 0;
    await assert.rejects(collectStats(repository, { fetchImpl: async () => { calls += 1; return response({}, status); } }), new RegExp(`HTTP ${status}`, 'u'));
    assert.equal(calls, 1);
  });
}
test('bounds retries on server errors', async () => {
  let calls = 0; const waits = [];
  await assert.rejects(collectStats(repository, { fetchImpl: async () => { calls += 1; return response({}, 503); }, sleep: async wait => waits.push(wait) }), /HTTP 503/u);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
});
test('retries transient failure and numeric Retry-After before succeeding', async () => {
  const mock = client(); let calls = 0; const waits = [];
  const result = await collectStats(repository, { fetchImpl: (...args) => {
    calls += 1;
    if (calls === 1) return Promise.resolve(response({}, 429, { 'retry-after': '2' }));
    return mock.fetchImpl(...args);
  }, sleep: async wait => waits.push(wait) });
  assert.equal(result.stars, 2);
  assert.deepEqual(waits, [2000]);
});
test('honors HTTP-date Retry-After and primary rate-limit reset times', async () => {
  const base = Date.parse('2026-11-13T00:00:00Z');
  for (const headers of [
    { 'retry-after': new Date(base + 3000).toUTCString() },
    { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((base + 3000) / 1000) },
  ]) {
    const mock = client(); let first = true; const waits = [];
    await collectStats(repository, { fetchImpl: (...args) => {
      if (first) { first = false; return Promise.resolve(response({}, 403, headers)); }
      return mock.fetchImpl(...args);
    }, now: () => base, sleep: async wait => waits.push(wait) });
    assert.deepEqual(waits, [3000]);
  }
});
test('does not retry a permissions 403 or wait indefinitely for rate limits', async () => {
  await assert.rejects(collectStats(repository, { fetchImpl: async () => response({}, 403) }), /HTTP 403/u);
  await assert.rejects(collectStats(repository, { fetchImpl: async () => response({}, 429, { 'retry-after': '61' }) }), /more than 60 seconds/u);
  await assert.rejects(collectStats(repository, { fetchImpl: async () => response({}, 429, { 'retry-after': 'invalid-date' }) }), /invalid Retry-After/u);
});
test('handles invalid JSON and network/timeout/redirect failures without leaking tokens', async () => {
  await assert.rejects(collectStats(repository, { fetchImpl: async () => new Response('not-json') }), /invalid JSON/u);
  await assert.rejects(collectStats(repository, { token: 'secret-fixture', fetchImpl: async () => { throw new Error('sensitive internals'); } }), error => {
    assert.match(error.message, /network request failed/u);
    assert.doesNotMatch(error.message, /secret-fixture|sensitive internals/u);
    return true;
  });
});
test('renders deterministic, honest metrics and contribution definitions', () => {
  const text = renderStats(fixture(), { updatedAt: new Date('2026-11-13T00:00:00Z') });
  assert.match(text, /Updated: 2026-11-13T00:00:00.000Z/u);
  assert.match(text, /\| Open issues \+ pull requests \| 9 \|/u);
  assert.match(text, /\[@alice\]\(https:\/\/github.com\/alice\)/u);
  assert.match(text, /not a measure of impact/u);
  assert.equal(renderStats(fixture(), { updatedAt: new Date(0) }), renderStats(fixture(), { updatedAt: new Date(0) }));
});
test('renders the empty leaderboard and validates all rendered fields', () => {
  assert.match(renderStats({ ...fixture(), contributors: [] }), /No ranked human contributors/u);
  assert.throws(() => renderStats(fixture(), { updatedAt: 'invalid' }), TypeError);
  assert.throws(() => renderStats(fixture(), { updatedAt: new Date(NaN) }), TypeError);
  assert.throws(() => renderStats({ ...fixture(), stars: -1 }), TypeError);
  assert.throws(() => renderStats({ ...fixture(), contributors: [{ login: 'bad|link', contributions: 1 }] }), TypeError);
  assert.throws(() => renderStats({ ...fixture(), contributors: [{ login: 'valid', contributions: -1 }] }), TypeError);
});
test('writes atomically, creates directories, avoids unnecessary rewrites, and cleans temporary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'error-inbox-stats-'));
  try {
    const target = join(root, 'docs', 'stats.md');
    assert.equal(await writeStats(target, 'first\n'), true);
    assert.equal(await readFile(target, 'utf8'), 'first\n');
    assert.equal(await writeStats(target, 'first\n'), false);
    assert.equal(await writeStats(target, 'second\n'), true);
    assert.deepEqual(await readdir(join(root, 'docs')), ['stats.md']);
    await assert.rejects(writeStats(join(root, 'docs'), 'invalid\n'));
    await writeFile(join(root, 'blocking-file'), 'unchanged');
    await assert.rejects(writeStats(join(root, 'blocking-file', 'stats.md'), 'invalid\n'));
    assert.equal(await readFile(join(root, 'blocking-file'), 'utf8'), 'unchanged');
  } finally { await rm(root, { recursive: true, force: true }); }
});
for (const args of [['--help'], ['--unknown'], ['--repo'], ['--repo', '../unsafe']]) {
  test(`CLI handles ${args.join(' ')} without network access`, () => {
    const result = spawnSync(process.execPath, ['scripts/update-project-stats.mjs', ...args], { encoding: 'utf8', env: {} });
    assert.equal(result.status, args[0] === '--help' ? 0 : 1);
  });
}
