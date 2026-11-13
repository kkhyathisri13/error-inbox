import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintText, lintRepository } from '../scripts/lib/lint.mjs';

test('accepts clean Markdown and JSON', () => {
  assert.deepEqual(lintText('README.md', '# Title\n\nBody.\n'), []);
  assert.deepEqual(lintText('package.json', '{}\n'), []);
});
for (const [label, text, expected] of [
  ['missing newline', 'hello', /exactly one newline/u],
  ['extra newline', 'hello\n\n', /exactly one newline/u],
  ['trailing whitespace', 'hello \n', /Trailing whitespace/u],
  ['CRLF', 'hello\r\n', /LF newlines/u],
  ['tabs', '\thello\n', /spaces instead of tabs/u],
  ['merge conflict', '<<<<<<< HEAD\n', /merge marker/u],
  ['heading before', 'body\n# Title\n\n', /before heading/u],
  ['heading after', '# Title\nbody\n', /after heading/u],
  ['unclosed fence', '# Title\n\n```js\nconst x = 1;\n', /Unclosed Markdown/u],
]) {
  test(`reports ${label}`, () => assert.ok(lintText('README.md', text).some(error => expected.test(error))));
}
test('ignores Markdown-looking text inside code fences, including longer closers and alternate fences', () => {
  for (const fence of ['```', '~~~']) {
    assert.deepEqual(lintText('README.md', `# Title\n\n${fence}js\n# Not a heading\ntext\n${fence}${fence[0]}\n`), []);
  }
});
test('reports malformed JSON', () => assert.match(lintText('package.json', '{oops}\n').join('\n'), /Invalid JSON/u));
test('enforces read-only workflow defaults, safe triggers, and immutable action pins', () => {
  const valid = 'permissions:\n  contents: read\njobs:\n  test:\n    steps:\n      - uses: actions/checkout@' + 'a'.repeat(40) + '\n';
  assert.deepEqual(lintText('.github/workflows/ci.yml', valid), []);
  assert.match(lintText('.github/workflows/ci.yml', valid.replace('a'.repeat(40), 'v7')).join('\n'), /complete commit SHA/u);
  assert.match(lintText('.github/workflows/ci.yml', valid.replace('contents: read', 'contents: write')).join('\n'), /contents: read/u);
  assert.match(lintText('.github/workflows/ci.yml', valid + 'on:\n  pull_request_target:\n').join('\n'), /PR-target/u);
  assert.deepEqual(lintText('.github/workflows/local.yml', valid.replace('actions/checkout@' + 'a'.repeat(40), './local/action')), []);
});
test('checks missing/empty files, syntax, local links, invalid URI encodings, and ignored directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'error-inbox-lint-'));
  try {
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'node_modules', 'invalid.mjs'), 'not valid javascript');
    await writeFile(join(root, 'valid.mjs'), 'export const ok = true;\n');
    await writeFile(join(root, 'broken.mjs'), 'export const =;\n');
    await writeFile(join(root, 'empty.md'), '\n');
    await writeFile(join(root, 'README.md'), '# Title\n\n[Valid](valid.mjs) [Missing](absent.md) [Outside](../outside.md) [Invalid](%ZZ.md) [Web](https://example.test) [Anchor](#title)\n');
    const result = await lintRepository(root, { requiredFiles: ['missing.md', 'empty.md'] });
    const joined = result.errors.join('\n');
    for (const pattern of [/Required file is missing/u, /Required file is empty/u, /JavaScript syntax error/u, /Broken local link/u, /escapes repository/u, /Invalid local link/u]) assert.match(joined, pattern);
    assert.doesNotMatch(joined, /node_modules/u);
    assert.equal(result.checkedFiles, 4);
    await writeFile(join(root, 'README.md'), '# Title\n\n```md\n[Sample](does-not-exist.md)\n```\n');
    assert.doesNotMatch((await lintRepository(root, { requiredFiles: [], checkSyntax: false })).errors.join('\n'), /Broken local link/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('rejects symlinks without following them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'error-inbox-link-'));
  try {
    await symlink(tmpdir(), join(root, 'external'));
    assert.match((await lintRepository(root, { requiredFiles: [] })).errors.join('\n'), /Symlinks are not supported/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
