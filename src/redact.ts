/**
 * Output hygiene for anything returned to the model or written to logs.
 * Order matters: redact first, then truncate, so a secret straddling the
 * truncation boundary can never survive as a partial prefix.
 *
 * Every pass here is linear in the text length: ScreenConnect free-text fields
 * (notes, extension attributes, script output) are written by anyone with
 * ScreenConnect write access, and one hostile record must not stall the event loop.
 */

export const REDACTED = '[REDACTED]';

/**
 * Normalized (lower-case, no `_`/`-`) key fragments whose string values are
 * secrets. Booleans and numbers under these keys (e.g. `bootstrapTokenEscrowed`,
 * `passcodePresent`) are status flags and are kept.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  'password',
  'passcode',
  'passphrase',
  'secret',
  'token',
  'recoverykey',
  'privatekey',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'sharedsecret',
  'unlocktoken',
];

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[_-]/g, '');
  if (k === 'pin' || k.endsWith('pin') || k.endsWith('pincode')) return true;
  return SENSITIVE_KEY_FRAGMENTS.some((f) => k.includes(f));
}

/** Recursively replaces string values under sensitive keys. Returns a new value; the input is not mutated. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 64) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key) && (typeof v === 'string' || Array.isArray(v))) {
        out[key] = typeof v === 'string' && v.length === 0 ? v : REDACTED;
      } else {
        out[key] = redactValue(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

const DOT = 0x2e;

/** Base64url characters plus ".": [A-Za-z0-9_.-]. */
function isTokenChar(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x5f || c === 0x2d || c === DOT;
}

/** Index of the first "eyJ" inside text[from, to), or -1. Never looks past `to`. */
function findEyJ(text: string, from: number, to: number): number {
  for (let i = from; i + 3 <= to; i++) {
    if (text.charCodeAt(i) === 0x65 && text.charCodeAt(i + 1) === 0x79 && text.charCodeAt(i + 2) === 0x4a) return i;
  }
  return -1;
}

/**
 * Redacts JWT-shaped tokens: three consecutive dot-separated segments of
 * [A-Za-z0-9_-], each at least 8 characters, the first counted from an "eyJ".
 * No word boundary is needed, so a token glued to other text still matches;
 * the text before its "eyJ" is kept.
 *
 * Every segment is tried as a header and overlapping or adjacent matches
 * merge into one redaction, so back-to-back tokens are removed whole: e.g.
 * `<jwt><jwt>` (the first signature glued to the second header), or a
 * JWT-shaped decoy whose third segment swallows a real token's header.
 *
 * O(n): each maximal run of [A-Za-z0-9_.-] is scanned once to record its
 * segment bounds, each segment is searched for "eyJ" once and only within
 * itself, and untouched text is copied in slices. A regex such as
 * \beyJ[...]{8,}\.[...]{8,}\.[...]{8,} instead retries from every "eyJ" of a
 * long run, which is quadratic on input such as "-eyJ" repeated.
 */
function redactJwts(text: string): string {
  const out: string[] = [];
  let copied = 0; // text[0, copied) is already in `out`, as itself or as REDACTED
  let i = 0;
  while (i < text.length) {
    if (!isTokenChar(text.charCodeAt(i))) {
      i++;
      continue;
    }
    const starts: number[] = [];
    const ends: number[] = [];
    let start = i;
    for (; i < text.length && isTokenChar(text.charCodeAt(i)); i++) {
      if (text.charCodeAt(i) === DOT) {
        starts.push(start);
        ends.push(i);
        start = i + 1;
      }
    }
    starts.push(start);
    ends.push(i);
    for (let k = 0; k + 2 < starts.length; k++) {
      const at = findEyJ(text, starts[k], ends[k]);
      if (at < 0 || ends[k] - at < 11 || ends[k + 1] - starts[k + 1] < 8 || ends[k + 2] - starts[k + 2] < 8) continue;
      // A match starting at or inside the previous redaction extends it instead of adding another marker.
      if (at > copied || out.length === 0) out.push(text.slice(copied, at), REDACTED);
      copied = Math.max(copied, ends[k + 2]);
    }
  }
  out.push(text.slice(copied));
  return out.join('');
}

/** XML tag-name characters: [A-Za-z0-9_]. */
function isTagChar(c: number): boolean {
  return (c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a) || (c >= 0x30 && c <= 0x39) || c === 0x5f;
}

function isSecretTag(tag: string): boolean {
  const t = tag.toLowerCase();
  return t.includes('password') || t === 'passcode' || t === 'pin' || t === 'secret' || t === 'token';
}

/**
 * Redacts the content of Classic API XML elements that carry secrets:
 * `<tag>content</tag>` where the tag names a secret (any length, any case),
 * the content holds no "<", and the closing tag repeats the name.
 *
 * O(n), with no regex: the old `<([a-z_]*password[a-z_0-9]*)>` pattern
 * backtracked quadratically on "<passwordpassword...", and capping the tag
 * length to avoid that let long password tags through. Each "<" is visited
 * once; a closing tag is compared only against the opening tag whose content
 * ends at it, so the comparisons add up to at most the length of the tags.
 */
function redactXmlSecrets(text: string): string {
  const out: string[] = [];
  let copied = 0;
  let i = text.indexOf('<');
  while (i !== -1) {
    let j = i + 1;
    while (j < text.length && isTagChar(text.charCodeAt(j))) j++;
    if (j === i + 1 || text.charCodeAt(j) !== 0x3e || !isSecretTag(text.slice(i + 1, j))) {
      i = text.indexOf('<', j);
      continue;
    }
    const close = text.indexOf('<', j + 1);
    if (close === -1) break;
    const nameEnd = close + 2 + (j - i - 1);
    if (
      text.charCodeAt(close + 1) === 0x2f &&
      text.charCodeAt(nameEnd) === 0x3e &&
      text.slice(close + 2, nameEnd).toLowerCase() === text.slice(i + 1, j).toLowerCase()
    ) {
      out.push(text.slice(copied, j + 1), REDACTED);
      copied = close;
    }
    i = close;
  }
  out.push(text.slice(copied));
  return out.join('');
}

/** "Bearer" plus one whitespace character: a fixed-length prefix, the rest is scanned. */
const BEARER = /\bBearer\s/gi;
const NON_SPACE = /\S/g;

/** Bearer token characters: [A-Za-z0-9._~+/-]. */
function isBearerChar(c: number): boolean {
  return isTagChar(c) || c === DOT || c === 0x2d || c === 0x7e || c === 0x2b || c === 0x2f;
}

/**
 * Redacts `Bearer <token>` (any case) through the token's trailing "=" padding.
 * Only bounded patterns run as regexes; the whitespace, token and padding are
 * scanned, so the pass is O(n) and cannot overflow the regex backtrack stack.
 */
function redactBearer(text: string): string {
  const out: string[] = [];
  let copied = 0;
  BEARER.lastIndex = 0;
  for (let m = BEARER.exec(text); m; m = BEARER.exec(text)) {
    NON_SPACE.lastIndex = m.index + m[0].length;
    let j = NON_SPACE.exec(text)?.index ?? text.length;
    const valueStart = j;
    while (j < text.length && isBearerChar(text.charCodeAt(j))) j++;
    if (j > valueStart) {
      while (text.charCodeAt(j) === 0x3d) j++;
      out.push(text.slice(copied, m.index), REDACTED);
      copied = j;
    }
    BEARER.lastIndex = j;
  }
  out.push(text.slice(copied));
  return out.join('');
}

// FileVault personal recovery key format (XXXX-XXXX-XXXX-XXXX-XXXX-XXXX). Fixed length.
const RECOVERY_KEY = /\b[A-Z0-9]{4}(?:-[A-Z0-9]{4}){5}\b/g;

/** Pattern-based redaction plus exact removal of any secrets known for this request. */
export function redactText(text: string, knownSecrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length > 0) out = out.split(secret).join(REDACTED).split(JSON.stringify(secret).slice(1, -1)).join(REDACTED);
  }
  out = out.replace(RECOVERY_KEY, REDACTED);
  out = redactBearer(out);
  out = redactXmlSecrets(out);
  return redactJwts(out);
}

export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n\n[truncated: ${omitted} more characters omitted. Narrow the query with filter, sections, page, or pageSize.]`;
}

/** Top-level array fields that hold a list page: ScreenConnect API `results`, this server's `items`. */
const PAGE_KEYS = ['results', 'items'];

function pageKey(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return PAGE_KEYS.find((k) => Array.isArray((value as Record<string, unknown>)[k]));
}

/**
 * Fits a list page under the cap by dropping items from the end while keeping
 * every other top-level field (totalCount, totalMatched, ...), so the output
 * stays valid JSON the model can page from. When even the first item does not
 * fit, returns the page with no items followed by that item as clearly marked
 * truncated text, never a bare empty page. Returns undefined when the page's
 * other fields alone do not fit, or when `text` no longer parses as the page.
 *
 * `text` is the whole page, serialized and already redacted as one string, and
 * the items are taken from it. Items are never redacted one by one: a secret
 * can span items (an XML element opened in one item's field and closed in the
 * next), and only the whole text shows it. Each candidate output is redacted
 * again before it is measured, since re-serializing can change escaping. The
 * list is written last.
 */
function shrinkPage(text: string, key: string, maxChars: number, redact: (s: string) => string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (pageKey(parsed) !== key) return undefined;
  const page = parsed as Record<string, unknown>;
  const list = page[key] as unknown[];
  const total = list.length;
  const fields = JSON.stringify({ ...page, [key]: undefined }).slice(1, -1);
  const items = list.map((v) => JSON.stringify(v) ?? 'null');
  const build = (n: number, hint: string) => {
    const meta = JSON.stringify({ truncated: true, returned_items: n, total_items_in_page: total, truncation_hint: hint }).slice(1, -1);
    return redact(`{${fields ? `${fields},` : ''}${meta},${JSON.stringify(key)}:[${items.slice(0, n).join(',')}]}`);
  };
  const fitHint = (n: number) =>
    `Only the first ${n} of ${total} items in this page fit in the response; the next page at the same pageSize would skip the rest. ` +
    `Repeat this request with pageSize (or limit) at most ${n}, or narrow it with filter or sections.`;

  // Output length grows with n, so binary-search the largest n that fits; the result is checked either way.
  let lo = 0;
  let hi = total;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (build(mid, fitHint(mid)).length <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0) return build(lo, fitHint(lo));
  if (total === 0) return undefined;

  const head = build(
    0,
    `The first of ${total} items alone exceeds the ${maxChars}-character response limit, so no items are returned as JSON; ` +
      'the start of that item follows as truncated text. Narrow the request with filter or sections, or fetch the item by id.'
  );
  const room = maxChars - head.length - 2;
  return room > 0 ? `${head}\n\n${truncate(redact(items[0]), room)}` : undefined;
}

/**
 * Serializes, redacts, then fits the cap. The single exit path for tool
 * output. The whole serialized value is redacted before anything is cut, and
 * length is measured on the redacted text. An oversized list page is shrunk
 * structurally (compact JSON, other top-level fields kept); anything else is
 * cut as text.
 */
export function renderSafe(value: unknown, maxChars: number, knownSecrets: readonly (string | undefined)[] = []): string {
  const redact = (text: string) => redactText(text, knownSecrets);
  if (typeof value === 'string') return truncate(redact(value), maxChars);
  const redacted = redactValue(value);
  const text = redact(JSON.stringify(redacted, null, 2) ?? 'null');
  if (text.length <= maxChars) return text;
  const key = pageKey(redacted);
  return (key && shrinkPage(text, key, maxChars, redact)) || truncate(text, maxChars);
}
