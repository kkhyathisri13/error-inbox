import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const IGNORED = new Set(['.git', 'node_modules', 'coverage']);
const TEXT_EXTENSIONS = new Set(['.mjs', '.js', '.json', '.md', '.yml', '.yaml']);
const REQUIRED = ['README.md', 'ARCHITECTURE.md', 'CONTRIBUTING.md', 'package.json',
  'package-lock.json', 'src/parse-error.mjs', 'test/parse-error.test.mjs',
  '.github/workflows/ci.yml'];

/** Dependency-free repository style, syntax, docs, and action-pin lint checks. */
export function lintText(path, text) {
  const errors = [];
  const report = (line, message) => errors.push(`${path}:${line}: ${message}`);
  if (!text.endsWith('\n') || text.endsWith('\n\n')) report(1, 'End with exactly one newline');
  const lines = text.split('\n');
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/[ \t]+$/u.test(line)) report(index + 1, 'Trailing whitespace');
    if (line.includes('\r')) report(index + 1, 'Use LF newlines');
    if (line.includes('\t')) report(index + 1, 'Use spaces instead of tabs');
    if (/^(?:<{7}|={7}|>{7})(?:\s|$)/u.test(line)) report(index + 1, 'Unresolved merge marker');
    if (extname(path) !== '.md') continue;
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
      continue;
    }
    if (!fence && /^#{1,6} /u.test(line)) {
      if (index > 0 && lines[index - 1] !== '') report(index + 1, 'Blank line required before heading');
      if (index + 1 < lines.length && lines[index + 1] !== '') report(index + 1, 'Blank line required after heading');
    }
  }
  if (fence) report(lines.length, 'Unclosed Markdown code fence');
  if (extname(path) === '.json') {
    try { JSON.parse(text); }
    catch { report(1, 'Invalid JSON'); }
  }
  if (path.startsWith('.github/workflows/') && /\.ya?ml$/u.test(path)) {
    if (!/^permissions:\n  contents: read$/mu.test(text)) report(1, 'Set default contents: read permissions');
    if (/^\s*pull_request_target:/mu.test(text)) report(1, 'Privileged PR-target triggers are not permitted');
    for (let index = 0; index < lines.length; index += 1) {
      const uses = /^\s*(?:- )?uses:\s*([^\s#]+)/u.exec(lines[index]);
      if (uses && !uses[1].startsWith('./') && !/^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/u.test(uses[1])) {
        report(index + 1, 'Pin external actions to a complete commit SHA');
      }
    }
  }
  return errors;
}

export async function lintRepository(rootPath, { requiredFiles = REQUIRED, checkSyntax = true } = {}) {
  const root = resolve(rootPath);
  const errors = [];
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (IGNORED.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute).split(sep).join('/');
      if (entry.isSymbolicLink()) errors.push(`${path}:1: Symlinks are not supported`);
      else if (entry.isDirectory()) await walk(absolute);
      else if (TEXT_EXTENSIONS.has(extname(path)) || ['.gitignore', '.editorconfig', '.node-version', '.npmrc'].includes(entry.name)) files.push({ path, absolute });
    }
  }
  await walk(root);
  const present = new Set(files.map(file => file.path));
  for (const path of requiredFiles) {
    if (!present.has(path)) errors.push(`${path}:1: Required file is missing`);
  }
  for (const { path, absolute } of files.sort((a, b) => a.path < b.path ? -1 : 1)) {
    const text = await readFile(absolute, 'utf8');
    errors.push(...lintText(path, text));
    if (requiredFiles.includes(path) && text.trim().length === 0) errors.push(`${path}:1: Required file is empty`);
    if (checkSyntax && ['.mjs', '.js'].includes(extname(path))) {
      const check = spawnSync(process.execPath, ['--check', absolute], { encoding: 'utf8' });
      if (check.status !== 0) errors.push(`${path}:1: JavaScript syntax error: ${(check.stderr || check.error?.message || '').trim()}`);
    }
    if (extname(path) === '.md') {
      let codeFence = null;
      const prose = text.split('\n').map(line => {
        const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
        if (delimiter) {
          if (!codeFence) codeFence = delimiter[1];
          else if (delimiter[1][0] === codeFence[0] && delimiter[1].length >= codeFence.length && !delimiter[2].trim()) codeFence = null;
          return '';
        }
        return codeFence ? '' : line;
      }).join('\n');
      for (const match of prose.matchAll(/!?\[[^\]]*\]\(([^\s)]+)\)/gu)) {
        const link = match[1];
        if (/^(?:[a-z][\w+.-]*:|#|\/\/)/iu.test(link)) continue;
        let target;
        try { target = resolve(dirname(absolute), decodeURIComponent(link.split(/[?#]/u, 1)[0])); }
        catch { errors.push(`${path}:1: Invalid local link: ${link}`); continue; }
        const local = relative(root, target);
        if (local === '..' || local.startsWith(`..${sep}`)) {
          errors.push(`${path}:1: Local link escapes repository: ${link}`);
          continue;
        }
        try { await stat(target); }
        catch { errors.push(`${path}:1: Broken local link: ${link}`); }
      }
    }
  }
  return { errors, checkedFiles: files.length };
}
