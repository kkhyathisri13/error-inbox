import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseError } from '../src/parse-error.mjs';

const simpleCases = [
  ['null', null, 'UnknownError', 'Unknown error'],
  ['undefined', undefined, 'UnknownError', 'Unknown error'],
  ['empty string', '', 'Error', ''],
  ['whitespace', '  ', 'Error', '  '],
  ['plain text', 'something failed', 'Error', 'something failed'],
  ['zero', 0, 'Error', '0'],
  ['false', false, 'Error', 'false'],
  ['true', true, 'Error', 'true'],
  ['negative number', -12, 'Error', '-12'],
  ['NaN', NaN, 'Error', 'NaN'],
  ['infinity', Infinity, 'Error', 'Infinity'],
  ['bigint', 9n, 'Error', '9'],
  ['symbol', Symbol('x'), 'Error', 'Symbol(x)'],
  ['anonymous symbol', Symbol(), 'Error', 'Symbol()'],
  ['function', () => {}, 'UnknownError', 'Unknown error'],
  ['empty object', {}, 'Error', 'Unknown error'],
  ['empty message', { message: '' }, 'Error', ''],
  ['non-string message', { message: 0 }, 'Error', 'Unknown error'],
  ['serialized error', { name: 'CustomError', message: 'bad' }, 'CustomError', 'bad'],
  ['invalid name', { name: 0, message: 'bad' }, 'Error', 'bad'],
  ['empty name', { name: '', message: 'bad' }, 'Error', 'bad'],
  ['invalid JSON', '{broken', 'Error', '{broken'],
  ['JSON scalar stays text', 'null', 'Error', 'null'],
  ['JSON quoted scalar stays text', '"bad"', 'Error', '"bad"'],
  ['colon in message', 'database: offline', 'Error', 'database: offline'],
  ['V8 header', 'TypeError: bad: input', 'TypeError', 'bad: input'],
  ['exception header', 'DOMException: denied', 'DOMException', 'denied'],
  ['empty header message', 'Error:', 'Error', ''],
  ['multiline error message', 'Error: first\nsecond', 'Error', 'first\nsecond'],
  ['BOM and CRLF', '\uFEFFError: first\r\nsecond\rthird', 'Error', 'first\nsecond\nthird'],
  ['Firefox text retained', 'broken\nrun@file.js:2:3', 'Error', 'broken\nrun@file.js:2:3'],
];
for (const [label, input, name, message] of simpleCases) {
  test(`normalizes ${label}`, () => assert.deepEqual(parseError(input), { name, message }));
}

for (const ErrorType of [Error, TypeError, RangeError, SyntaxError, ReferenceError, URIError, EvalError]) {
  test(`normalizes native ${ErrorType.name}`, () => {
    const input = new ErrorType('example');
    const result = parseError(input);
    assert.equal(result.name, ErrorType.name);
    assert.equal(result.message, 'example');
    assert.match(result.stack, /example/u);
    assert.doesNotThrow(() => JSON.stringify(result));
  });
}

test('supports cross-realm native errors', () => {
  const result = parseError(vm.runInNewContext('new TypeError("cross realm")'));
  assert.equal(result.name, 'TypeError');
  assert.equal(result.message, 'cross realm');
});
test('supports non-enumerable data fields and immutable inputs', () => {
  const input = Object.create(null);
  Object.defineProperty(input, 'message', { value: 'safe', enumerable: false });
  Object.freeze(input);
  assert.deepEqual(parseError(input), { name: 'Error', message: 'safe' });
});
test('supports native Error cause, empty message, and numeric code zero', () => {
  const input = new Error('', { cause: new Error('root') });
  input.code = 0;
  const result = parseError(input);
  assert.equal(result.message, '');
  assert.equal(result.code, 0);
  assert.equal(result.cause.message, 'root');
});
test('preserves explicit null causes and serialized stacks', () => {
  assert.deepEqual(parseError({ message: 'bad', cause: null, stack: 'custom stack', code: 'E_FAIL' }), {
    name: 'Error', message: 'bad', stack: 'custom stack', code: 'E_FAIL',
    cause: { name: 'UnknownError', message: 'Unknown error' },
  });
});
for (const code of [NaN, Infinity, false, null, {}, 1n]) {
  test(`ignores non-JSON error code ${String(code)}`, () => assert.equal(Object.hasOwn(parseError({ code }), 'code'), false));
}
test('parses JSON envelopes and nested errors', () => {
  const result = parseError(' {"error":{"name":"ApiError","message":"bad","cause":{"message":"root"}}} ');
  assert.equal(result.name, 'ApiError');
  assert.equal(result.cause.message, 'root');
});
test('does not unwrap a documented message or discard false envelope values', () => {
  assert.equal(parseError({ message: 'outer', error: 'inner' }).message, 'outer');
  assert.equal(parseError({ error: false }).message, 'false');
});
test('parses V8 stacks with CRLF, URLs, Windows paths, anonymous frames, and Unicode', () => {
  const text = 'TypeError: 日本語\r\n    at f (C:\\src\\a.js:1:2)\r\n    at https://example.test/a.js:3:4\r\n    at <anonymous>';
  const result = parseError(text);
  assert.equal(result.name, 'TypeError');
  assert.equal(result.message, '日本語');
  assert.equal(result.stack, text.replaceAll('\r\n', '\n'));
});
test('unnamed V8 stack preserves the first-line message', () => {
  assert.equal(parseError('failed\n    at run (file.js:1:2)').message, 'failed');
});
test('does not execute coercion, getters, or toJSON on arbitrary objects', () => {
  let calls = 0;
  const input = { toString() { calls += 1; throw new Error('unsafe'); },
    toJSON() { calls += 1; throw new Error('unsafe'); } };
  for (const key of ['name', 'message', 'stack', 'code', 'cause', 'errors', 'error']) {
    Object.defineProperty(input, key, { get() { calls += 1; throw new Error('unsafe'); } });
  }
  assert.deepEqual(parseError(input), { name: 'Error', message: 'Unknown error' });
  assert.equal(calls, 0);
});
test('does not execute an overridden native stack accessor', () => {
  const input = new Error('native');
  let calls = 0;
  Object.defineProperty(input, 'stack', { get() { calls += 1; throw new Error('unsafe'); } });
  assert.equal(parseError(input).message, 'native');
  assert.equal(calls, 0);
});
test('survives throwing native stack formatting hooks', () => {
  const previous = Error.prepareStackTrace;
  Error.prepareStackTrace = () => { throw new Error('formatter failure'); };
  try { assert.equal(parseError(new Error('still useful')).message, 'still useful'); }
  finally {
    if (previous === undefined) delete Error.prepareStackTrace;
    else Error.prepareStackTrace = previous;
  }
});
test('survives hostile and revoked proxies', () => {
  assert.equal(parseError(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('trap'); } })).message, 'Unknown error');
  const { proxy, revoke } = Proxy.revocable([], {});
  revoke();
  assert.doesNotThrow(() => parseError(proxy));
});
test('bounds cyclic prototype traversal', () => {
  let input;
  input = new Proxy({}, { getPrototypeOf: () => input });
  assert.equal(parseError(input).message, 'Unknown error');
});
test('detects circular cause/envelope/aggregate paths', () => {
  const input = { message: 'self' }; input.cause = input;
  assert.equal(parseError(input).cause.name, 'CircularError');
  const envelope = {}; envelope.error = envelope;
  assert.equal(parseError(envelope).name, 'CircularError');
  const array = []; array.push(array);
  assert.equal(parseError(array).errors[0].name, 'CircularError');
});
test('shared references are not falsely marked circular', () => {
  const shared = { message: 'shared' };
  assert.deepEqual(parseError([shared, shared]).errors.map(x => x.message), ['shared', 'shared']);
});
test('supports native AggregateError, JSON arrays, empty and sparse arrays', () => {
  const result = parseError(new AggregateError([new Error('one'), 'two'], 'multiple'));
  assert.equal(result.name, 'AggregateError');
  assert.deepEqual(result.errors.map(x => x.message), ['one', 'two']);
  assert.equal(parseError('["one",{"message":"two"}]').errors.length, 2);
  assert.deepEqual(parseError([]).errors, []);
  assert.equal(parseError(new Array(1)).errors[0].name, 'UnknownError');
});
test('skips aggregate element accessors and non-array errors', () => {
  const errors = [];
  Object.defineProperty(errors, '0', { get() { throw new Error('unsafe'); } });
  assert.equal(parseError({ errors }).errors[0].name, 'UnknownError');
  assert.equal(Object.hasOwn(parseError({ errors: {} }), 'errors'), false);
});
test('bounds depth exactly, including depth zero', () => {
  const input = { message: 'a', cause: { message: 'b', cause: { message: 'c' } } };
  assert.equal(parseError(input, { maxDepth: 1 }).cause.message, 'b');
  assert.equal(parseError(input, { maxDepth: 1 }).cause.cause.name, 'TruncatedError');
  assert.equal(parseError(input, { maxDepth: 0 }).cause.truncated, true);
});
test('bounds aggregate size, including zero', () => {
  const result = parseError(['a', 'b', 'c'], { maxAggregateErrors: 1 });
  assert.equal(result.errors.length, 1);
  assert.equal(result.omittedErrors, 2);
  assert.equal(result.truncated, true);
  assert.equal(parseError(['a'], { maxAggregateErrors: 0 }).omittedErrors, 1);
});
test('bounds total nodes across both causes and aggregates', () => {
  const input = { message: 'a', cause: { message: 'b' }, errors: [['x', 'y'], ['z']] };
  const count = value => 1 + (value.cause ? count(value.cause) : 0) + (value.errors ?? []).reduce((sum, item) => sum + count(item), 0);
  assert.ok(count(parseError(input, { maxNodes: 4 })) <= 4);
  assert.equal(parseError(input, { maxNodes: 1 }).truncated, true);
  assert.equal(parseError({ error: 'wrapped' }, { maxNodes: 1 }).truncated, true);
  assert.equal(parseError('{"message":"a","cause":"b"}', { maxNodes: 1 }).truncated, true);
});
test('clips all string fields without splitting surrogate pairs', () => {
  const result = parseError({ name: 'LongError', message: 'a😀b', code: 'LONG', stack: 'stack' }, { maxStringLength: 2 });
  assert.equal(result.name, 'Lo'); assert.equal(result.message, 'a');
  assert.equal(result.code, 'LO'); assert.equal(result.stack, 'st');
  assert.equal(result.truncated, true);
  assert.equal(parseError('😀', { maxStringLength: 1 }).message, '');
});
test('oversized JSON is not parsed and output stays bounded', () => {
  const input = JSON.stringify({ message: 'x'.repeat(70_000) });
  const result = parseError(input);
  assert.equal(result.message.length, 16_384);
  assert.equal(result.truncated, true);
});
test('does not copy secrets or prototype pollution fields', () => {
  const result = parseError('{"message":"ok","token":"private","__proto__":{"polluted":true}}');
  assert.deepEqual(result, { name: 'Error', message: 'ok' });
  assert.equal({}.polluted, undefined);
});
for (const options of [null, [], 1, 'bad', { typo: 1 }]) {
  test(`rejects invalid options ${JSON.stringify(options)}`, () => assert.throws(() => parseError('x', options), TypeError));
}
for (const key of ['maxDepth', 'maxStringLength', 'maxAggregateErrors', 'maxNodes']) {
  for (const value of [-1, 1.5, NaN, Infinity, '5', 1_000_000]) {
    test(`rejects invalid ${key}=${String(value)}`, () => assert.throws(() => parseError('x', { [key]: value }), RangeError));
  }
}
