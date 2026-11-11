/**
 * The only path for outbound HTTP to ScreenConnect (every extension API call). Each new connection resolves the hostname itself, rejects the
 * whole answer if any address is private/loopback/link-local/metadata/
 * reserved, and connects the socket to exactly the validated address, so a
 * DNS rebind between validation and connect (or between API calls) cannot redirect traffic. Pooled keep-alive sockets were
 * validated when they connected.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { promises as dns, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { allowPrivateBaseUrl, requestTimeoutMs } from './config.js';
import { isBlockedAddress } from './ip-policy.js';
import { ScreenConnectApiError, UnsafeBaseUrlError } from './types.js';

export interface OutboundInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

export type Transport = (url: URL, init: OutboundInit, allowPrivate: boolean) => Promise<Response>;
export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolver: Resolver = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

let resolver: Resolver = defaultResolver;
let transportOverride: Transport | undefined;

/** Test-only: swap the DNS resolver used by the pinned lookup. Pass undefined to restore. */
export function setResolver(r: Resolver | undefined): void {
  resolver = r ?? defaultResolver;
}

/** Test-only: replace the socket-level transport (the suite routes it to a stubbed fetch). Pass undefined to restore. */
export function setTransport(t: Transport | undefined): void {
  transportOverride = t;
}

const UNSAFE_RESOLUTION = 'ScreenConnect host resolves to a private, loopback, link-local, or reserved address; refusing to connect.';

/** Resolves a hostname and returns its addresses only if every one is allowed. */
export async function resolveAllowed(hostname: string, allowPrivate: boolean): Promise<LookupAddress[]> {
  let addresses: LookupAddress[];
  try {
    addresses = await resolver(hostname);
  } catch (err) {
    throw new ScreenConnectApiError(`Could not resolve the ScreenConnect host (${(err as NodeJS.ErrnoException).code ?? 'DNS error'}).`);
  }
  if (addresses.length === 0) throw new ScreenConnectApiError('Could not resolve the ScreenConnect host (no addresses).');
  if (!allowPrivate && addresses.some((a) => isBlockedAddress(a.address))) throw new UnsafeBaseUrlError(UNSAFE_RESOLUTION);
  return addresses;
}

/** A net/tls `lookup` that only ever hands the socket addresses resolveAllowed accepted. */
export function pinnedLookup(allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolveAllowed(hostname, allowPrivate).then(
      (all) => {
        const family = options.family === 4 || options.family === 6 ? options.family : undefined;
        const picked = family ? all.filter((a) => a.family === family) : all;
        if (picked.length === 0) {
          callback(Object.assign(new Error(`No IPv${family} address for host`), { code: 'ENOTFOUND' }), '', 0);
        } else if (options.all) {
          (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, picked);
        } else {
          callback(null, picked[0].address, picked[0].family);
        }
      },
      (err: Error) => callback(err as NodeJS.ErrnoException, '', 0)
    );
  };
}

const agents = new Map<string, http.Agent>();

function agentFor(protocol: string, allowPrivate: boolean): http.Agent {
  const key = `${protocol}${allowPrivate ? ':private' : ''}`;
  let agent = agents.get(key);
  if (!agent) {
    const opts = { keepAlive: true, maxSockets: 32, lookup: pinnedLookup(allowPrivate) };
    agent = protocol === 'https:' ? new https.Agent(opts) : new http.Agent(opts);
    agents.set(key, agent);
  }
  return agent;
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

const nodeTransport: Transport = (url, init, allowPrivate) =>
  new Promise<Response>((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = { ...init.headers };
    if (init.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(init.body));
    const req = mod.request(
      url,
      { method: init.method, headers, agent: agentFor(url.protocol, allowPrivate), lookup: pinnedLookup(allowPrivate), signal: init.signal },
      (res) => {
        const out = new Headers();
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        const status = res.statusCode ?? 502;
        if (NULL_BODY_STATUS.has(status)) {
          res.resume();
          resolve(new Response(null, { status, headers: out }));
          return;
        }
        resolve(new Response(Readable.toWeb(res) as ReadableStream<Uint8Array>, { status, statusText: res.statusMessage, headers: out }));
      }
    );
    req.on('error', reject);
    req.end(init.body);
  });

/** Sends one request through the pinned transport. Redirects are never followed. */
export async function outboundFetch(rawUrl: string, init: OutboundInit): Promise<Response> {
  const allowPrivate = allowPrivateBaseUrl();
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') {
    throw new UnsafeBaseUrlError('ScreenConnect base URL must use https://.');
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (!allowPrivate && isIP(host) !== 0 && isBlockedAddress(host)) {
    throw new UnsafeBaseUrlError('ScreenConnect base URL points at a private, loopback, or reserved address.');
  }
  try {
    return await (transportOverride ?? nodeTransport)(url, init, allowPrivate);
  } catch (err) {
    if (init.signal.aborted && init.signal.reason instanceof Error) throw init.signal.reason;
    throw err;
  }
}

/** Reads a response body as text, cancelling the stream as soon as it exceeds maxBytes. */
export async function readBoundedText(res: Response, maxBytes: number, where: string): Promise<string> {
  const tooLarge = () =>
    new ScreenConnectApiError(`ScreenConnect response for ${where} exceeded ${maxBytes} bytes; narrow the query with filter or limit.`);
  const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const callerSignal = new AsyncLocalStorage<AbortSignal>();

/** Runs fn with the MCP request's cancellation signal, so ScreenConnect calls abort when the client cancels or disconnects. */
export function runWithAbortSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  return signal ? callerSignal.run(signal, fn) : fn();
}

/** Per-request timeout, combined with the caller's cancellation signal when one is in scope. */
export function outboundSignal(opts: { ignoreCaller?: boolean } = {}): AbortSignal {
  const timeout = AbortSignal.timeout(requestTimeoutMs());
  const caller = opts.ignoreCaller ? undefined : callerSignal.getStore();
  return caller ? AbortSignal.any([timeout, caller]) : timeout;
}

/** Current MCP cancellation signal, without adding a per-call timeout. */
export function currentAbortSignal(): AbortSignal | undefined { return callerSignal.getStore(); }
