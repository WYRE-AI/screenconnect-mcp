import { isIP } from 'node:net';
import { isBlockedAddress } from './ip-policy.js';
import { UnsafeBaseUrlError } from './types.js';

/**
 * Hostnames that appear in ScreenConnect's own docs, our README/.env.example, or
 * common copy-paste templates. A sidecar pointed at one of these is
 * misconfigured, and in gateway mode it would also mean Conduit forwarded
 * an unvalidated value.
 */
const PLACEHOLDER_HOSTS = new Set([
  'yourserver.screenconnect.com',
  'your-server.screenconnect.com',
  'yourinstance.screenconnect.com',
  'your-instance.screenconnect.com',
  'yourorg.screenconnect.com',
  'your-org.screenconnect.com',
  'yourcompany.screenconnect.com',
  'your-company.screenconnect.com',
  'org.screenconnect.com',
  'example.screenconnect.com',
  'instance.screenconnect.com',
  'tenant.screenconnect.com',
  'screenconnect.com',
]);

const RESERVED_SUFFIXES = ['.example', '.invalid', '.test', '.localhost', '.local', '.internal', '.home.arpa'];

const EXAMPLE_DOMAINS = ['example.com', 'example.net', 'example.org'];

function isPlaceholderHost(host: string): boolean {
  if (PLACEHOLDER_HOSTS.has(host)) return true;
  if (/[<>{}]|changeme|change-me|replace-me|placeholder/.test(host)) return true;
  return EXAMPLE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || RESERVED_SUFFIXES.some((s) => host.endsWith(s))) return true;
  return isIP(host) !== 0 && isBlockedAddress(host);
}

const SAFE_PATH = /^(\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*\/?$/;

export interface BaseUrlOptions {
  /** Permit loopback and private ranges over HTTPS. Local/on-prem development only. */
  allowPrivate?: boolean;
}

/**
 * Validates a tenant's ScreenConnect base URL and returns it normalized
 * (origin + optional context path, no trailing slash). Throws
 * UnsafeBaseUrlError with a message that is safe to show the caller.
 *
 * Literal private/loopback/link-local addresses are refused here. DNS names
 * are resolved and checked at connect time, on every outbound request, by
 * `egress.ts`, which pins the socket to the validated address.
 */
export function normalizeBaseUrl(raw: string | undefined, options: BaseUrlOptions = {}): string {
  const value = (raw ?? '').trim();
  if (!value) throw new UnsafeBaseUrlError('ScreenConnect base URL is empty.');
  if (value.length > 2048) throw new UnsafeBaseUrlError('ScreenConnect base URL is too long.');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeBaseUrlError('ScreenConnect base URL is not a valid absolute URL.');
  }

  const allowPrivate = options.allowPrivate === true;
  if (url.protocol !== 'https:') {
    throw new UnsafeBaseUrlError('ScreenConnect base URL must use https://.');
  }
  if (url.username || url.password) {
    throw new UnsafeBaseUrlError('ScreenConnect base URL must not contain embedded credentials.');
  }
  if (url.search || url.hash || value.includes('?') || value.includes('#')) {
    throw new UnsafeBaseUrlError('ScreenConnect base URL must not contain a query string or fragment.');
  }
  if (!SAFE_PATH.test(url.pathname) || /(\/|\\|%2f|%5c)(\.|%2e){1,2}(\/|\\|%2f|%5c|$)/i.test(value)) {
    throw new UnsafeBaseUrlError('ScreenConnect base URL has an unsupported path.');
  }

  const host = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (!host) throw new UnsafeBaseUrlError('ScreenConnect base URL has no host.');
  if (isPlaceholderHost(host)) {
    throw new UnsafeBaseUrlError(
      'ScreenConnect base URL is a placeholder. Set it to your ScreenConnect server, e.g. https://<your-org>.screenconnect.com.'
    );
  }
  if (!allowPrivate && isPrivateHost(host)) {
    throw new UnsafeBaseUrlError('ScreenConnect base URL points at a private, loopback, or reserved address.');
  }

  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host.toLowerCase()}${path}`;
}
