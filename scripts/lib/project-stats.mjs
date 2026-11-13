import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export function validateRepository(repository) {
  if (typeof repository !== 'string' ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u.test(repository) ||
      ['.', '..'].includes(repository.split('/')[1])) {
    throw new TypeError('Repository must be owner/repo (not a URL or path)');
  }
  return repository;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Invalid GitHub ${label}`);
  }
  return value;
}

/** GitHub.com only: fixed origins, bounded pagination/retries, no redirect leakage. */
export async function collectStats(repository, {
  token, fetchImpl = globalThis.fetch, sleep = delay, maxPages = 100, now = Date.now,
} = {}) {
  validateRepository(repository);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1_000) {
    throw new RangeError('maxPages must be an integer in [1, 1000]');
  }
  const path = repository.split('/').map(encodeURIComponent).join('/');
  const headers = { Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'error-inbox-project-stats' };
  if (token) headers.Authorization = `Bearer ${token}`;

  async function request(endpoint) {
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(`https://api.github.com/repos/${path}${endpoint}`, {
          headers, redirect: 'error', signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new Error('GitHub network request failed (including timeout or redirect)');
      }
      if (response.ok) {
        if (response.status === 204) return [];
        try { return await response.json(); }
        catch { throw new Error('GitHub returned invalid JSON'); }
      }
      const retryAfter = response.headers.get('retry-after');
      const rateLimited = response.status === 429 || (response.status === 403 &&
        (response.headers.get('x-ratelimit-remaining') === '0' || retryAfter !== null));
      if (attempt >= 2 || (!rateLimited && ![502, 503, 504].includes(response.status))) {
        throw new Error(`GitHub request failed with HTTP ${response.status}`);
      }
      let wait = 1_000 * (2 ** attempt);
      if (retryAfter !== null) {
        const seconds = Number(retryAfter);
        const parsed = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retryAfter) - now();
        if (!Number.isFinite(parsed)) throw new Error('GitHub supplied invalid Retry-After');
        wait = Math.max(0, parsed);
      } else if (rateLimited) {
        const reset = Number(response.headers.get('x-ratelimit-reset'));
        if (Number.isFinite(reset) && reset > 0) wait = Math.max(wait, reset * 1_000 - now());
      }
      if (wait > 60_000) throw new Error('GitHub rate limit requires waiting more than 60 seconds; retry later');
      await sleep(wait);
    }
  }

  async function pages(endpoint) {
    const all = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const separator = endpoint.includes('?') ? '&' : '?';
      const items = await request(`${endpoint}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(items)) throw new Error('GitHub returned a non-array page');
      all.push(...items);
      if (items.length < 100) return all;
    }
    throw new Error('GitHub pagination limit reached; refusing to publish partial stats');
  }

  const metadata = await request('');
  if (!metadata || typeof metadata.full_name !== 'string' ||
      metadata.full_name.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('GitHub returned mismatched repository metadata');
  }
  const contributors = await pages('/contributors');
  const pulls = await pages('/pulls?state=open');
  const unique = new Map();
  for (const contributor of contributors) {
    if (contributor.type === 'Bot' || (typeof contributor.login === 'string' && contributor.login.endsWith('[bot]'))) continue;
    if (typeof contributor.login !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(contributor.login)) {
      throw new Error('GitHub returned an invalid contributor login');
    }
    const count = nonnegativeInteger(contributor.contributions, 'contribution count');
    const key = contributor.login.toLowerCase();
    const previous = unique.get(key);
    if (!previous || count > previous.contributions) {
      unique.set(key, { login: contributor.login, contributions: count });
    }
  }
  const ordered = [...unique.values()].sort((a, b) => b.contributions - a.contributions ||
    (a.login.toLowerCase() < b.login.toLowerCase() ? -1 : 1));
  const pullNumbers = new Set(pulls.map(p => {
    const number = nonnegativeInteger(p.number, 'pull request number');
    if (number === 0) throw new TypeError('Invalid GitHub pull request number');
    return number;
  }));
  return { repository: metadata.full_name,
    stars: nonnegativeInteger(metadata.stargazers_count, 'star count'),
    forks: nonnegativeInteger(metadata.forks_count, 'fork count'),
    openIssuesAndPullRequests: nonnegativeInteger(metadata.open_issues_count, 'open issue/PR count'),
    openPullRequests: pullNumbers.size, contributors: ordered };
}

export function renderStats(stats, { updatedAt = new Date() } = {}) {
  validateRepository(stats.repository);
  if (!(updatedAt instanceof Date) || !Number.isFinite(updatedAt.getTime())) {
    throw new TypeError('updatedAt must be a valid Date');
  }
  for (const key of ['stars', 'forks', 'openIssuesAndPullRequests', 'openPullRequests']) {
    nonnegativeInteger(stats[key], key);
  }
  const lines = ['# Project statistics', '',
    '<!-- Generated by scripts/update-project-stats.mjs. Do not edit manually. -->', '',
    `Repository: [${stats.repository}](https://github.com/${stats.repository})`, '',
    `Updated: ${updatedAt.toISOString()}`, '',
    '| Metric | Count |', '| --- | ---: |',
    `| Stars | ${stats.stars} |`, `| Forks | ${stats.forks} |`,
    `| Open issues + pull requests | ${stats.openIssuesAndPullRequests} |`,
    `| Open pull requests | ${stats.openPullRequests} |`,
    `| Ranked human contributors | ${stats.contributors.length} |`, '',
    '## Contribution leaderboard', '', '| Rank | Contributor | Default-branch commits |',
    '| ---: | --- | ---: |'];
  stats.contributors.forEach((contributor, index) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(contributor.login)) {
      throw new TypeError('Invalid contributor login');
    }
    nonnegativeInteger(contributor.contributions, 'contribution count');
    lines.push(`| ${index + 1} | [@${contributor.login}](https://github.com/${contributor.login}) | ${contributor.contributions} |`);
  });
  if (stats.contributors.length === 0) lines.push('| — | No ranked human contributors | 0 |');
  lines.push('', '## How to interpret these numbers', '',
    '- Commit counts come from GitHub’s cached contributors endpoint for the default branch.',
    '- Bots and anonymous contributors are not ranked. Counts are not a measure of impact.',
    '- Reviews, issue comments, and unmerged PR commits are not included in the leaderboard.',
    '- Open issues + pull requests is GitHub’s combined count, not a bug count.',
    '- Endpoint snapshots are not atomic and may briefly differ during concurrent updates.',
    '- Statistics are updated by a reviewable bot PR, never an automatic merge.', '');
  return lines.join('\n');
}

export async function writeStats(outputPath, content) {
  const target = resolve(outputPath);
  try {
    if (await readFile(target, 'utf8') === content) return false;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}
