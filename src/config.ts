export type ToolTier = 'read' | 'write' | 'admin';

export const ALL_TIERS: readonly ToolTier[] = ['read', 'write', 'admin'];

/** Writes and admin actions require explicit opt-in. */
export const DEFAULT_TIERS: readonly ToolTier[] = ['read'];

/**
 * Parses SCREENCONNECT_TOOL_TIERS (comma-separated subset of read,write,admin).
 * Unset or blank means DEFAULT_TIERS. An unknown value throws so a typo such
 * as `admn` fails loudly at startup instead of silently changing the surface.
 */
export function parseToolTiers(raw: string | undefined): ReadonlySet<ToolTier> {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return new Set(DEFAULT_TIERS);
  const tiers = new Set<ToolTier>();
  for (const part of trimmed.split(',')) {
    const value = part.trim().toLowerCase();
    if (!value) continue;
    if (!(ALL_TIERS as readonly string[]).includes(value)) {
      throw new Error(`Invalid SCREENCONNECT_TOOL_TIERS entry "${value}". Allowed: ${ALL_TIERS.join(', ')}.`);
    }
    tiers.add(value as ToolTier);
  }
  if (tiers.size === 0) return new Set(DEFAULT_TIERS);
  return tiers;
}

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  const n = Number.parseInt((raw ?? '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

export const MAX_BODY_BYTES = 1024 * 1024;

export function requestTimeoutMs(): number {
  return positiveInt(process.env.SCREENCONNECT_REQUEST_TIMEOUT_MS, 30_000, 120_000);
}

export function maxResponseChars(): number {
  return positiveInt(process.env.SCREENCONNECT_MAX_RESPONSE_CHARS, 60_000, 1_000_000);
}

export type AuthMode = 'gateway' | 'env';

/**
 * The single AUTH_MODE parser (trimmed, case-insensitive). Unset or blank is
 * `env`; anything else unknown throws. Every caller must go through this so
 * the startup check and the per-request credential path can never disagree.
 */
export function parseAuthMode(raw: string | undefined): AuthMode {
  const value = (raw ?? '').trim().toLowerCase() || 'env';
  if (value !== 'gateway' && value !== 'env') {
    throw new Error(`AUTH_MODE must be "gateway" or "env" (got "${(raw ?? '').trim()}").`);
  }
  return value;
}

let gatewayLocked = false;

/** Called once the HTTP server starts in gateway mode. Irreversible for the process lifetime. */
export function lockGatewayMode(): void {
  gatewayLocked = true;
}

/** Test-only. */
export function resetGatewayLock(): void {
  gatewayLocked = false;
}

/** Fails closed: an unparseable AUTH_MODE counts as gateway, so env credentials are never used by mistake. */
export function isGatewayMode(): boolean {
  if (gatewayLocked) return true;
  try {
    return parseAuthMode(process.env.AUTH_MODE) === 'gateway';
  } catch {
    return true;
  }
}

/** Upper bound on any upstream ScreenConnect response body, enforced while streaming and before parsing, redaction, or truncation. */
export function maxUpstreamBytes(): number {
  return positiveInt(process.env.SCREENCONNECT_MAX_UPSTREAM_BYTES, 16 * 1024 * 1024, 128 * 1024 * 1024);
}

/** Header Conduit may send to narrow (never widen) the tiers enabled by SCREENCONNECT_TOOL_TIERS for one request. */
export const TOOL_TIERS_HEADER = 'x-conduit-tool-tiers';

/**
 * Intersects the configured tiers with a per-request tier header. Unknown or
 * not-configured entries are dropped, so the header can only remove tiers.
 * A present header that names no configured tier yields an empty set (no
 * tools), not the configured default.
 */
export function narrowTiers(configured: ReadonlySet<ToolTier>, header: string | undefined): ReadonlySet<ToolTier> {
  if (header === undefined) return configured;
  const requested = new Set(
    header
      .split(',')
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean)
  );
  return new Set(ALL_TIERS.filter((t) => configured.has(t) && requested.has(t)));
}

/**
 * Local/on-prem escape hatch for private or loopback ScreenConnect hosts; HTTPS remains mandatory. Ignored in gateway mode: a tenant-supplied header must never reach
 * the sidecar's own network.
 */
export function allowPrivateBaseUrl(): boolean {
  return !isGatewayMode() && process.env.SCREENCONNECT_ALLOW_PRIVATE_BASE_URL === '1';
}
