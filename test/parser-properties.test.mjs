import test from 'node:test';
import assert from 'node:assert/strict';
import { parseError } from '../src/parse-error.mjs';

test('deterministic cyclic/branching payloads preserve JSON-safety and every output budget', () => {
  let seed = 0x51a7beef;
  const random = limit => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) % limit;
  };
  const allowed = new Set(['name', 'message', 'code', 'stack', 'cause', 'errors', 'omittedErrors', 'truncated']);
  for (let iteration = 0; iteration < 300; iteration += 1) {
    const nodes = Array.from({ length: 12 }, (_, index) => ({
      name: `Example${index}Error`, message: 'detail😀'.repeat(random(12)),
      code: `E_${index}`, stack: 'trace'.repeat(random(15)),
    }));
    for (const node of nodes) {
      if (random(2)) node.cause = nodes[random(nodes.length)];
      if (random(2)) node.errors = Object.freeze(Array.from({ length: random(7) }, () => nodes[random(nodes.length)]));
      if (random(4) === 0) { delete node.message; node.error = nodes[random(nodes.length)]; }
      Object.freeze(node);
    }
    const limits = { maxNodes: 1 + random(30), maxAggregateErrors: random(6),
      maxDepth: random(6), maxStringLength: 1 + random(20) };
    const result = parseError(nodes[0], limits);
    assert.doesNotThrow(() => JSON.stringify(result), `iteration ${iteration}`);
    function check(record) {
      for (const key of Object.keys(record)) assert.ok(allowed.has(key));
      assert.equal(typeof record.name, 'string');
      assert.equal(typeof record.message, 'string');
      for (const key of ['name', 'message', 'code', 'stack']) {
        if (typeof record[key] === 'string') assert.ok(record[key].length <= limits.maxStringLength);
      }
      if (record.errors) assert.ok(record.errors.length <= limits.maxAggregateErrors);
      return 1 + (record.cause ? check(record.cause) : 0) +
        (record.errors ?? []).reduce((sum, child) => sum + check(child), 0);
    }
    assert.ok(check(result) <= limits.maxNodes, `node budget at iteration ${iteration}`);
  }
});
