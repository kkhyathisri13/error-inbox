import { types } from 'node:util';

const DEFAULTS = Object.freeze({
  maxDepth: 5,
  maxStringLength: 16_384,
  maxAggregateErrors: 20,
  maxNodes: 100,
});
const RANGES = { maxDepth: [0, 20], maxStringLength: [1, 65_536],
  maxAggregateErrors: [0, 100], maxNodes: [1, 1_000] };
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;

// Read data properties without invoking application-defined accessors or coercion.
function dataProperty(value, key) {
  let current = value;
  const seen = new Set();
  for (let i = 0; current !== null && i < 8 && !seen.has(current); i += 1) {
    seen.add(current);
    try {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
      current = Object.getPrototypeOf(current);
    } catch {
      return undefined; // Includes revoked or hostile proxies.
    }
  }
  return undefined;
}

function arrayLength(value) {
  try {
    return Array.isArray(value) ? dataProperty(value, 'length') : undefined;
  } catch {
    return undefined;
  }
}

function stackOf(value) {
  const stack = dataProperty(value, 'stack');
  if (typeof stack === 'string') return stack;
  // Modern V8 implements native Error.stack as a lazy accessor. Bypass any
  // user-defined stack getter; native formatting hooks can still throw.
  if (types.isNativeError(value) && nativeStackGetter) {
    try {
      const nativeStack = Reflect.apply(nativeStackGetter, value, []);
      if (typeof nativeStack === 'string') return nativeStack;
    } catch {
      // A stack is optional; normalization must survive a formatter failure.
    }
  }
  return undefined;
}

/**
 * Normalize a thrown value, serialized error, JSON envelope, or V8 stack text.
 * No input is mutated. Output contains only JSON-safe, allowlisted fields.
 */
export function parseError(input, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Parser options must be an object');
  }
  const limits = { ...DEFAULTS, ...options };
  for (const key of Object.keys(options)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new TypeError(`Unknown parser option: ${key}`);
  }
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    if (!Number.isInteger(limits[key]) || limits[key] < min || limits[key] > max) {
      throw new RangeError(`${key} must be an integer in [${min}, ${max}]`);
    }
  }
  const ancestors = new Set();
  let remaining = limits.maxNodes;

  function clip(text, result) {
    if (text.length <= limits.maxStringLength) return text;
    result.truncated = true;
    // Do not split a UTF-16 surrogate pair at the boundary.
    let end = limits.maxStringLength;
    if (end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]) &&
        /[\uDC00-\uDFFF]/u.test(text[end])) end -= 1;
    return text.slice(0, end);
  }

  function fields(name, message) {
    const result = {};
    result.name = clip(name, result);
    result.message = clip(message, result);
    return result;
  }

  function aggregate(value, length, result, depth) {
    result.errors = [];
    let i = 0;
    for (; i < Math.min(length, limits.maxAggregateErrors) && remaining > 0; i += 1) {
      result.errors.push(visit(dataProperty(value, String(i)), depth + 1));
    }
    if (i < length) {
      result.omittedErrors = length - i;
      result.truncated = true;
    }
    return result;
  }

  function textError(value, depth) {
    const normalized = value.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
    // Limit JSON parsing independently from the output string limit.
    const prefix = normalized.trimStart()[0];
    if (normalized.length <= 65_536 && (prefix === '{' || prefix === '[')) {
      try {
        const decoded = JSON.parse(normalized);
        if (decoded !== null && typeof decoded === 'object') {
          // JSON transport is not an additional semantic cause depth or node.
          remaining += 1;
          return visit(decoded, depth);
        }
      } catch {
        // Invalid JSON remains useful literal text rather than becoming an error.
      }
    }
    const firstLine = normalized.split('\n', 1)[0];
    const match = /^([A-Za-z_$][A-Za-z0-9_.$]*(?:Error|Exception)|Error|Exception): ?(.*)$/u.exec(firstLine);
    const isStack = /\n\s+at(?:\s|$)/u.test(normalized);
    const result = fields(match?.[1] ?? 'Error',
      match ? match[2] + (isStack ? '' : normalized.slice(firstLine.length)) :
        (isStack ? firstLine : normalized));
    if (isStack) result.stack = clip(normalized, result);
    return result;
  }

  function visit(value, depth) {
    remaining -= 1;
    if (depth > limits.maxDepth) {
      return { ...fields('TruncatedError', 'Maximum error depth reached'), truncated: true };
    }
    if (typeof value === 'string') return textError(value, depth);
    if (value === null || value === undefined) return fields('UnknownError', 'Unknown error');
    if (typeof value !== 'object') {
      if (typeof value === 'function') return fields('UnknownError', 'Unknown error');
      return fields('Error', String(value));
    }
    if (ancestors.has(value)) return { ...fields('CircularError', 'Circular error reference'), truncated: true };
    ancestors.add(value);
    try {
      const length = arrayLength(value);
      if (length !== undefined) {
        return aggregate(value, length, fields('AggregateError', 'Multiple errors'), depth);
      }
      const message = dataProperty(value, 'message');
      const wrapped = dataProperty(value, 'error');
      if (message === undefined && wrapped !== undefined && remaining > 0) {
        return visit(wrapped, depth + 1);
      }
      const name = dataProperty(value, 'name');
      const result = fields(typeof name === 'string' && name ? name : 'Error',
        typeof message === 'string' ? message : 'Unknown error');
      if (message === undefined && wrapped !== undefined) result.truncated = true;
      const stack = stackOf(value);
      if (stack !== undefined) result.stack = clip(stack, result);
      const code = dataProperty(value, 'code');
      if (typeof code === 'string') result.code = clip(code, result);
      else if (typeof code === 'number' && Number.isFinite(code)) result.code = code;
      const cause = dataProperty(value, 'cause');
      if (cause !== undefined) {
        if (remaining > 0) result.cause = visit(cause, depth + 1);
        else result.truncated = true;
      }
      const errors = dataProperty(value, 'errors');
      const errorCount = arrayLength(errors);
      if (errorCount !== undefined) aggregate(errors, errorCount, result, depth);
      return result;
    } finally {
      ancestors.delete(value);
    }
  }

  return visit(input, 0);
}
