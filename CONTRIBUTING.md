# Team collaboration guidelines

## Review process

- Every pull request requires at least one independent peer review before merging.
- Never substitute a self-authored comment or a green directory-listing job for
  independent review or application tests.
- Explain the actual behavior or documentation change, rationale, risks, and
  verification in the PR description. Avoid placeholder feature claims.
- Review readability, maintainability, architectural consistency, data privacy,
  compatibility, and failure paths. Add regression tests for fixes.
- Consolidate exact duplicates rather than merging redundant changes. Closing a
  PR does not require deleting its branch or rewriting its history.

## Local checks

Use a current patch of Node 22 (22.14+), 24, or 26. Node 24 is the local default.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run lint
npm test
npm run test:coverage
```

Tests use `node:test` and mock all GitHub requests. No production credentials or
network access are needed. Runtime and development npm dependencies are both
empty; keep the package lockfile committed and consistent with the manifest.
Run the same commands on every supported Node release line before release.

The coverage gates apply to `src/` and `scripts/lib/`: at least 90% lines,
90% functions, and 85% branches. Coverage is a guardrail, not proof of correctness.
The CLI adapters are tested separately for help and argument failures.

## Formatting and lint policy

- Use UTF-8, LF newlines, two-space indentation, no tabs or trailing spaces,
  and exactly one final newline.
- Separate Markdown headings from surrounding text with blank lines.
- Keep local documentation links valid and fences balanced.
- The project linter performs syntax and repository policy checks. It does not
  replace code review, ESLint-style semantic rules, or full YAML validation.
- Pin external GitHub Actions to verified full commit SHAs. Keep the matching
  release version comment and review dependency upgrades before changing pins.
- PR CI has read-only permissions and does not receive a write token. Do not
  introduce privileged PR-target execution or persist checkout credentials.

## Error parser changes

Document any change to accepted input forms or the canonical output contract in
[ARCHITECTURE.md](ARCHITECTURE.md). Cover empty/falsy values, Unicode, malformed
JSON, non-enumerable Error fields, lazy stacks, cycles, bounded aggregates,
accessors/proxies, causes, output budgets, and invalid configuration.
Do not add automatic network requests or persistence to the parser.

## Statistics and automation changes

Do not hand-edit [PROJECT_STATS.md](PROJECT_STATS.md). Run the updater for an
intentional snapshot. Never store tokens, email addresses, or raw error payloads
in generated statistics. Commit counts are not a measure of contribution quality.

Keep automatic commits limited to `PROJECT_STATS.md` on
`automation/project-stats`. The workflow must open a reviewable PR and dispatch
CI; it must not auto-merge or bypass the peer-review requirement.

## Communication and task tracking

Use GitHub issues for bugs, features, and administrative tasks. If the team has
a primary Slack channel, use it for daily syncs and quick questions; do not
assume a channel or external system is configured by this repository.
Keep project boards and milestone tags up to date where those features are used.

## Release checklist

1. Give every pending PR an explicit disposition; resolve duplicates and review
   findings without silently losing branches or work.
2. Run all offline tests and lint checks on Node 22, 24, and 26 in CI.
3. Verify action pins, default-branch-only write automation, the statistics diff,
   and the manual disable path.
4. Obtain independent peer review and resolve comments before merging.
5. Confirm the documented scope. This project is a utility/tooling baseline,
   not an authenticated, persistent, deployed error-ingestion backend.
