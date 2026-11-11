import { ArgumentError } from './types.js';

type Args = Record<string, unknown>;

/**
 * Rejects path segments that could change which ScreenConnect endpoint is hit:
 * empty, `.`, `..`, anything containing `/` or `\`, percent-encoded
 * separators, or control characters. Callers still encodeURIComponent.
 */
export function assertSafePathSegment(value: string, label = 'path parameter'): string {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    /[/\\]/.test(value) ||
    /%(2f|5c|2e)/i.test(value) ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ArgumentError(`Invalid ${label}: must be a single path segment without ".", "..", or "/".`);
  }
  return value;
}

export function optionalString(args: Args, key: string, opts: { max?: number; pattern?: RegExp } = {}): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ArgumentError(`"${key}" must be a string.`);
  const trimmed = v.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > (opts.max ?? 1000)) throw new ArgumentError(`"${key}" is too long (max ${opts.max ?? 1000}).`);
  if (opts.pattern && !opts.pattern.test(trimmed)) throw new ArgumentError(`"${key}" has an invalid format.`);
  return trimmed;
}

export function requiredString(args: Args, key: string, opts: { max?: number; pattern?: RegExp } = {}): string {
  const v = optionalString(args, key, opts);
  if (v === undefined) throw new ArgumentError(`"${key}" is required.`);
  return v;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function requiredId(args: Args, key: string): string {
  return requiredString(args, key, { max: 36, pattern: SESSION_ID });
}

export function optionalInt(args: Args, key: string, opts: { min: number; max: number }): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new ArgumentError(`"${key}" must be an integer.`);
  if (n < opts.min || n > opts.max) throw new ArgumentError(`"${key}" must be between ${opts.min} and ${opts.max}.`);
  return n;
}

export function optionalBool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ArgumentError(`"${key}" must be a boolean.`);
  return v;
}

export function optionalEnum<T extends string>(args: Args, key: string, allowed: readonly T[]): T | undefined {
  const v = optionalString(args, key, { max: 100 });
  if (v === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(v)) throw new ArgumentError(`"${key}" must be one of: ${allowed.join(', ')}.`);
  return v as T;
}

export function requiredEnum<T extends string>(args: Args, key: string, allowed: readonly T[]): T {
  const v = optionalEnum(args, key, allowed);
  if (v === undefined) throw new ArgumentError(`"${key}" is required (one of: ${allowed.join(', ')}).`);
  return v;
}

/** Requires the explicit `confirm: true` flag on admin-tier tools. */
export function requireConfirm(args: Args): void {
  if (args.confirm !== true) {
    throw new ArgumentError(
      'This is an admin-tier action. Confirm with the user, then call again with "confirm": true.'
    );
  }
}
