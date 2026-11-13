# Architecture

## Current scope and truth boundary

The original repository contained three short Markdown documents and a workflow
that listed the directory. No backend source, parser, package manifest, tests,
database, HTTP route, queue, or deployment configuration existed.

This baseline introduces two actual execution paths: a bounded error-normalizing
library and a repository-statistics updater. It also adds offline tests and CI.
It does **not** turn the repository into a deployed error-tracking service.
References to ingestion, review, and status reporting describe the project scope;
only the concrete components below are implemented.

## Component map

| Component | Location | Responsibility |
| --- | --- | --- |
| Error normalization | `src/parse-error.mjs` | Convert supported inputs into bounded, JSON-safe error records |
| Statistics collection/rendering | `scripts/lib/project-stats.mjs` | Read complete GitHub snapshots, rank contributors, render and atomically write Markdown |
| Statistics CLI | `scripts/update-project-stats.mjs` | Validate arguments and environment; run the updater |
| Repository lint | `scripts/lib/lint.mjs`, `scripts/lint.mjs` | Check syntax, formatting, JSON, docs, required files, and action policies |
| Offline tests | `test/*.test.mjs` | Parser, HTTP mocks, pagination, retries, output safety, lint, and workflow-policy regression coverage |
| Read-only validation | `.github/workflows/ci.yml` | Validate Node 22, 24, and 26 on a fixed Ubuntu runner |
| Write automation | `.github/workflows/project-stats.yml` | Open/update a statistics-only bot PR and explicitly dispatch CI |
| Generated reporting | `PROJECT_STATS.md` | Timestamped repository metrics and contribution leaderboard |
| Human process | `CONTRIBUTING.md` | Independent peer review, meaningful PRs, and release gates |

There are no runtime or development npm dependencies. The package is private,
uses ECMAScript modules, and uses only Node built-ins. The manifest and lockfile
are committed so CI can verify a reproducible, empty dependency graph.

## Error-processing flow

```text
Caller-owned input
  -> validate parser limits
  -> recognize native/serialized/text/envelope/aggregate input
  -> read allowlisted fields without ordinary accessor/coercion execution
  -> normalize message and optional stack, code, cause, aggregate members
  -> apply cycle, depth, string, aggregate-size, and total-node limits
  -> return a JSON-safe record to the caller
  -> caller-owned redaction, transport, storage, and alerting (not implemented here)
```

`parseError()` is synchronous and has no network, filesystem, logging, database,
or process-exit side effects. Configuration mistakes throw a TypeError or
RangeError. Unsupported or malformed error payloads are represented safely
rather than being treated as parser configuration errors.

### Parser contract

```js
parseError(input, {
  maxDepth: 5,
  maxStringLength: 16384,
  maxAggregateErrors: 20,
  maxNodes: 100,
});
```

Every record has `name` and `message` strings. Optional fields are:

- `stack`: a string, if a stack is available.
- `code`: a string or finite number; numeric zero is preserved.
- `cause`: another normalized record. An explicit null cause becomes UnknownError.
- `errors`: normalized aggregate members, when an array is supplied.
- `omittedErrors`: how many aggregate members were omitted by size/node limits.
- `truncated`: true on a record whose own data or children had to be bounded.

The allowlist intentionally omits arbitrary metadata, request bodies, tokens,
custom enumerable fields, and prototype-pollution keys. It is not a redaction
engine: secrets or personal data already embedded in messages/stacks remain there.
Do not persist, share, or log records until the caller applies an appropriate
privacy and retention policy.

### Supported input forms

1. Native Errors, including non-enumerable fields, standard subclasses, cross-realm
   errors, causes, and AggregateError members.
2. Serialized error objects with string `name`/`message`, an optional data-property
   stack, a supported code, cause, and array-valued errors.
3. `{ error: ... }` envelopes when no message is provided. Falsy wrapped values
   are not silently discarded.
4. JSON object or array strings up to 65,536 UTF-16 code units. Invalid JSON remains
   literal text. JSON scalar strings are not implicitly interpreted as errors.
5. Plain text and V8-style Error/Exception headers and stack text. CRLF/CR become LF;
   a leading BOM is removed. Stack frames are preserved as text, not parsed into
   structured file/line records. Firefox/native-language frames are not interpreted.
6. Other primitive thrown values, including zero, false, bigint, NaN, Infinity,
   and symbols, become strings. Null/undefined become UnknownError. Functions and
   objects without usable error fields produce a generic message.

Empty string messages remain empty. String names/codes/stacks are bounded too.
The parser does not mutate inputs, call arbitrary toString/toJSON methods, or
follow arbitrary enumerable object graphs.

### Safety limits and limitations

- Maximum cause/aggregate/envelope nesting is five by default; the root is depth zero.
  Beyond the limit, an explicit TruncatedError record is returned.
- Circular ancestor paths produce CircularError records. Reusing the same object
  in independent aggregate positions is not incorrectly treated as a cycle.
- Maximum string length is 16,384 UTF-16 code units by default. Truncation does not
  split a valid surrogate pair. The `truncated` flag is per record, not a global
  claim that every ancestor contains all descendant data.
- At most twenty members per aggregate and one hundred canonical output nodes
  are emitted by default, so deeply branching aggregates cannot grow unbounded.
- JSON decoding is separately capped at 65,536 code units. The library is not a
  substitute for upstream transport/body-size limits on already-allocated inputs.
- Data-property lookup is bounded and skips ordinary getters. Hostile/revoked proxy
  failures are caught, but proxy traps are executable JavaScript and cannot be
  sandboxed by this library. Prefer decoded JSON for untrusted remote payloads.
- On modern V8, native Error stacks are lazy accessors. A captured native getter
  supports those without invoking an overridden application stack getter. Native
  stack formatting can still invoke Error.prepareStackTrace and V8 formatting
  hooks; formatting failures are caught and the optional stack is omitted.
- This parser does not recognize every vendor envelope or stack-trace language.
  Add a documented adapter and regression tests before expanding that contract.

## Statistics data flow

```text
Default-branch workflow or intentional local CLI invocation
  -> validate owner/repo (not arbitrary URLs)
  -> GitHub.com REST repository metadata
  -> exhaust contributors pagination and open-PR pagination
  -> validate numeric counts and GitHub logins
  -> exclude bots; deduplicate logins; sort by count, then login
  -> render deterministic Markdown for a supplied snapshot timestamp
  -> write a sibling temporary file and atomically rename it to PROJECT_STATS.md
  -> workflow lints the result
  -> workflow creates/updates a statistics-only branch and PR
  -> workflow dispatches the normal CI matrix
  -> independent maintainer review and merge (never automatic)
```

The CLI reads `GITHUB_REPOSITORY` or `--repo owner/repo`, `GITHUB_TOKEN` if set,
and optional `--output path`. The default output is `PROJECT_STATS.md`.
It does not commit, push, open PRs, merge, or delete branches. GitHub Enterprise
API endpoints are not supported by this version; requests are fixed to GitHub.com.

### API and metric semantics

- Repository metadata supplies stars, forks, and GitHub's combined count of open
  issues and PRs. That count is not labeled as bugs or as standalone issues.
- `/contributors` supplies cached default-branch commit counts. Anonymous entries
  are not requested; bot accounts are excluded from ranking. Reviews, issue
  discussion, unmerged commits, effort, and impact are not inferred from commits.
- `/pulls?state=open` supplies unique open PR numbers across all pages.
- Every paginated endpoint requests one hundred entries per page and continues
  until a short/empty page. Even an exactly full final page is followed by another
  request. The default safety cap is one hundred pages per endpoint; reaching it
  fails closed rather than publishing a partial leaderboard.
- These endpoints are not an atomic database snapshot. Cached contributor counts
  and concurrent PR changes can differ briefly. The generated timestamp records
  when the snapshot was rendered, not a guarantee of transactional consistency.
- Only public login/profile links and aggregate counts are rendered, never token
  values, private transport errors, email addresses, or raw error reports.

### Failure handling

Each HTTP attempt has a fifteen-second timeout and refuses redirects to prevent
credential leakage to another origin. HTTP 429, qualifying rate-limited 403s,
and HTTP 502/503/504 have at most two retries. Retry-After/reset headers are
respected; waits over sixty seconds fail with an operator-facing retry-later
message. Permanent permission/not-found failures, malformed JSON, invalid counts,
wrong repository metadata, and pagination exhaustion fail without publishing data.

All collection/validation completes before the output write. Unchanged content
is not rewritten. A temporary sibling file is cleaned up after replacement; a
failed collection leaves the prior statistics file intact. Paths are controlled
by the local operator; the workflow fixes its only committed path to PROJECT_STATS.md.

## Validation and CI

The CI workflow runs on PRs to main, pushes to main, and manual dispatch. It uses
Ubuntu 24.04 intentionally rather than the moving ubuntu-latest label. Each Node
22/24/26 job verifies the lockfile, runs lint, runs offline tests with coverage
gates, and ensures checks did not alter tracked files. PR jobs have read-only
contents permission, no write-token environment, and no persisted Git credential.

The supported release lines follow the [Node release schedule](https://github.com/nodejs/Release/blob/main/schedule.json)
as of November 2026. Node 22.14 is the oldest declared patch; use a current patch
of each line. The action runtime (Node 24 inside checkout/setup-node) is separate
from the project test matrix.

Coverage gates are 90% lines, 90% functions, and 85% branches for src/ and
scripts/lib/. Tests cover parser boundaries and hostile inputs; API pagination,
authentication-header scoping, retries, bad responses, ranking and atomic output;
and lint rules and workflow invariants. Requests are mocked: unit tests do not
prove live GitHub permissions or deployment readiness.

The dependency-free linter checks JavaScript syntax, formatting, JSON, required
non-empty files, Markdown headings/fences/local file links, and action-pin/default
permission policies. It is not ESLint, a complete YAML parser, a security audit,
or a replacement for peer review. Workflow YAML must also be reviewed and
validated by GitHub when published.

## Automation operations

The statistics workflow runs Mondays at 06:23 UTC and on manual dispatch, but
its write-capable job is conditional on the default branch. It never executes
PR code under a privileged PR-target trigger. Only that job receives contents:
write, pull-requests: write, and actions: write permissions. The last permission
is used solely to dispatch CI for the statistics branch.

External actions are pinned to verified full commit SHAs with release comments:
checkout v7.0.1, setup-node v7.1.0, and create-pull-request v8.1.3. Update pins only
after reviewing the upstream release and resolving its immutable commit.
The updater has no npm supply-chain dependency or install-script execution.

Before enabling the workflow, allow GitHub Actions to create pull requests in
repository settings and confirm the selected permissions are permitted by the
organization. No PAT is required for the repository-scoped GITHUB_TOKEN.
Token-authored ordinary PR events do not trigger CI automatically, so the
workflow explicitly dispatches ci.yml on automation/project-stats. A failed
CI dispatch leaves a reviewable, unmerged PR and a failed automation run; resolve
permissions or dispatch CI manually before considering a merge.

Only PROJECT_STATS.md is included in the automatic commit. The bot never writes
directly to main, auto-approves/merges, or deletes branches. The fixed branch is
owned by this automation and may be refreshed/rebased by the PR action; do not
put human feature work there. Concurrent statistics jobs are serialized.

To disable automation, disable the Update project statistics workflow in GitHub
Actions or remove its schedule in a reviewed change. To recover from a bad
snapshot, close its PR without merging, fix the updater with a regression test,
and manually dispatch a new run from the reviewed default branch.

## Production-service work not implemented

A real backend still needs explicit decisions and implementation for authenticated
HTTP ingestion, payload/rate limits, tenancy/isolation, redaction and retention,
fingerprinting/deduplication, persistent storage and migrations, background queues,
retry/dead-letter handling, alert delivery, operational telemetry, health checks,
backups, deployment/secrets management, and load/security testing. There is no
implicit server or database hidden behind the parser flow above.

A production release of this repository can truthfully deliver the documented
utility/tooling baseline after CI and peer review; it must not be represented
as a production-deployed error-inbox backend.
