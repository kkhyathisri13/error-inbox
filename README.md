# error-inbox

A small foundation for normalizing error reports, reviewing project changes,
and reporting repository activity. This repository started as documentation;
it does **not** contain a deployed backend, database, or ingestion API.

## What is implemented

- A dependency-free [error parser](src/parse-error.mjs) with bounded recursion,
  aggregate sizes, string lengths, and total output nodes.
- Offline unit tests for parser edge cases, statistics collection, and lint rules.
- [CI](.github/workflows/ci.yml) for supported Node 22, 24, and 26 release lines.
- A [statistics updater](scripts/update-project-stats.mjs) and reviewable weekly
  [automation workflow](.github/workflows/project-stats.yml).
- [Architecture and operational boundaries](ARCHITECTURE.md),
  [contribution guidance](CONTRIBUTING.md), and [project statistics](PROJECT_STATS.md).

## Development

Use the latest patch of Node 22 (at least 22.14), 24, or 26. The local default
in `.node-version` is Node 24. There are no npm dependencies or install hooks.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run lint
npm test
npm run test:coverage
```

Without npm, the equivalent checks can be run directly with Node:

```sh
node scripts/lint.mjs
node --test test/*.test.mjs
```

The lint command checks JavaScript syntax, text formatting, JSON, required files,
Markdown heading spacing and local links, and GitHub Actions pin/permission
policies. It is a dependency-free project linter, **not ESLint or a complete YAML
semantic validator**. Tests make no real network calls and require no token.

## Parse an error

```js
import { parseError } from './src/parse-error.mjs';

const error = parseError({
  name: 'ApiError',
  message: 'Request failed',
  code: 'E_REQUEST',
  cause: { message: 'Connection closed' },
});
console.log(JSON.stringify(error));
```

The parser accepts native Errors, serialized objects, JSON object/array text,
`{ error: ... }` envelopes, V8-style stack text, and primitive thrown values.
Only known fields are copied. Messages and stacks are **not automatically
redacted**; callers must apply their own privacy policy before storage or sharing.
See [the parser contract](ARCHITECTURE.md#parser-contract) for limitations.

## Update project statistics

```sh
npm run stats:update -- --repo owner/repo
```

For authenticated reads, supply `GITHUB_TOKEN` using your environment’s secret
mechanism; do not paste real tokens into command history. Omit the variable for
public, unauthenticated requests with lower rate limits.
The script only reads GitHub.com and writes `PROJECT_STATS.md` locally; it does
not commit, push, open PRs, or merge. Never put real tokens in committed files.
The workflow performs the separate, scoped commit/PR steps after review.

The scheduled job runs Mondays at 06:23 UTC, and can be manually dispatched from
the default branch. It opens or updates `automation/project-stats` rather than
writing directly to `main`. Repository settings must allow GitHub Actions to
create pull requests. See [automation operations](ARCHITECTURE.md#automation-operations)
for permissions, CI dispatch, failure handling, and how to disable it.

## Release readiness

Passing tests validate this utility/tooling baseline, not a live production
service. HTTP transport, authentication, persistence, tenancy, alerting, and
production deployment are not implemented. Require all three CI matrix jobs and
an independent peer review before merging. See [the release checklist](CONTRIBUTING.md#release-checklist).
