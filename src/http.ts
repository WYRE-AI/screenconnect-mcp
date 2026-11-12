import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { validateCredentials, runWithCredentials } from './client.js';
import { lockGatewayMode, MAX_BODY_BYTES, narrowTiers, parseAuthMode, TOOL_TIERS_HEADER, type AuthMode } from './config.js';
import { verifyS2sHeader, S2S_HEADER } from './s2s-verify.js';
import { createServer } from './server.js';
import { getDefaultToolset, toolsetForTiers } from './tools/index.js';
import type { ScreenConnectCredentials } from './types.js';
import { logger } from './utils/logger.js';

/**
 * HTTP transport. Fails closed:
 * - refuses to start without a real CONDUIT_S2S_SECRET (>= 32 chars, not a
 *   known placeholder, not a repeated pattern) unless MCP_ALLOW_INSECURE_DEV=1,
 *   which binds 127.0.0.1 only;
 * - AUTH_MODE=gateway takes credentials only from per-request X-ScreenConnect-* headers
 *   and never falls back to the process environment (the process is locked
 *   to gateway mode once the server starts);
 * - AUTH_MODE=env refuses to start with missing or placeholder SCREENCONNECT_* values;
 * - X-Conduit-Tool-Tiers can only narrow SCREENCONNECT_TOOL_TIERS for one request.
 */

const LOOPBACK_HOST = '127.0.0.1';
export const MIN_S2S_SECRET_LENGTH = 32;

const KNOWN_PLACEHOLDER_SECRETS = new Set([
  'replace-with-a-real-secret',
  'replace-with-openssl-rand-hex-32',
  'your-s2s-secret',
  'your-secret',
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'example',
  'replace-me',
  's2s-secret',
  'conduit-s2s-secret',
]);

export class StartupError extends Error {}

export type { AuthMode };

export interface HttpConfig {
  s2sSecret: string;
  host: string;
  port: number;
  authMode: AuthMode;
  allowedHosts: ReadonlySet<string> | null;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, '$1');
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

/** Placeholder, too short, or a short pattern repeated (e.g. "aaaa..." or "abcabc..."). */
export function s2sSecretProblem(secret: string): string | null {
  if (KNOWN_PLACEHOLDER_SECRETS.has(secret.toLowerCase())) return 'is a known placeholder';
  if (/replace|changeme|change-me|placeholder|example|your-?secret/i.test(secret)) return 'looks like a placeholder';
  if (secret.length < MIN_S2S_SECRET_LENGTH) return `is shorter than ${MIN_S2S_SECRET_LENGTH} characters`;
  if (/^(.{1,8}?)\1+$/.test(secret)) return 'is a repeated character pattern';
  if (new Set(secret).size < 8) return 'has too few distinct characters';
  return null;
}

function parseAllowedHosts(raw: string | undefined): ReadonlySet<string> | null {
  const entries = (raw ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return entries.length ? new Set(entries) : null;
}

/** Validates the environment for the HTTP transport. Throws StartupError; never logs the secret. */
export function resolveHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  let authMode: AuthMode;
  try {
    authMode = parseAuthMode(env.AUTH_MODE);
  } catch (err) {
    throw new StartupError((err as Error).message);
  }

  const port = Number.parseInt(env.MCP_HTTP_PORT || '8080', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new StartupError('MCP_HTTP_PORT must be a valid TCP port.');

  const configuredHost = (env.MCP_HTTP_HOST ?? '').trim();
  const secret = (env.CONDUIT_S2S_SECRET ?? '').trim();
  let host = configuredHost || LOOPBACK_HOST;

  if (!secret) {
    if (env.MCP_ALLOW_INSECURE_DEV !== '1') {
      throw new StartupError(
        'Refusing to start HTTP server: CONDUIT_S2S_SECRET is empty. Set it to the gateway-provisioned secret (openssl rand -hex 32), or set MCP_ALLOW_INSECURE_DEV=1 for local development only.'
      );
    }
    if (configuredHost && !isLoopbackHost(configuredHost)) {
      logger.error(`MCP_HTTP_HOST=${configuredHost} ignored: MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET binds ${LOOPBACK_HOST} only.`);
    }
    logger.error(
      'SECURITY WARNING: starting HTTP WITHOUT service-to-service authentication (MCP_ALLOW_INSECURE_DEV=1). Local development only; bound to 127.0.0.1.'
    );
    host = LOOPBACK_HOST;
  } else {
    const problem = s2sSecretProblem(secret);
    if (problem) {
      throw new StartupError(
        `Refusing to start HTTP server: CONDUIT_S2S_SECRET ${problem}. Generate one with \`openssl rand -hex 32\`.`
      );
    }
  }

  if (authMode === 'env') {
    const missing = ['SCREENCONNECT_BASE_URL', 'SCREENCONNECT_API_SECRET'].filter((k) => !(env[k] ?? '').trim());
    if (missing.length) throw new StartupError(`AUTH_MODE=env requires ${missing.join(', ')}.`);
    try {
      validateCredentials({ baseUrl: env.SCREENCONNECT_BASE_URL ?? '', apiSecret: env.SCREENCONNECT_API_SECRET ?? '', origin: env.SCREENCONNECT_ORIGIN || undefined, extensionId: env.SCREENCONNECT_EXTENSION_ID || undefined }, env.SCREENCONNECT_ALLOW_PRIVATE_BASE_URL === '1');
    } catch (err) {
      throw new StartupError(`Refusing to start: SCREENCONNECT_BASE_URL is not usable. ${(err as Error).message}`);
    }
  }

  return { s2sSecret: secret, host, port, authMode, allowedHosts: parseAllowedHosts(env.MCP_ALLOWED_HOSTS) };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function hostAllowed(req: IncomingMessage, allowed: ReadonlySet<string> | null): boolean {
  if (!allowed) return true;
  const host = (req.headers.host ?? '').trim().toLowerCase();
  if (!host) return false;
  if (allowed.has(host)) return true;
  const withoutPort = host.replace(/^\[([^\]]+)\](:\d+)?$/, '$1').replace(/:\d+$/, '');
  return allowed.has(withoutPort);
}

class BodyTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number.parseInt(req.headers['content-length'] ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new BodyTooLargeError();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

function gatewayCredentials(req: IncomingMessage): { creds?: ScreenConnectCredentials; status?: number; error?: string } {
  const rawBaseUrl = headerValue(req.headers['x-screenconnect-base-url']);
  const apiSecret = headerValue(req.headers['x-screenconnect-api-secret']);
  if (!rawBaseUrl || !apiSecret) return { status: 401, error: 'Missing X-ScreenConnect-Base-Url or X-ScreenConnect-Api-Secret.' };
  try {
    return { creds: validateCredentials({ baseUrl: rawBaseUrl, apiSecret, origin: headerValue(req.headers['x-screenconnect-origin']), extensionId: headerValue(req.headers['x-screenconnect-extension-id']) }) };
  } catch {
    return { status: 400, error: 'Invalid ScreenConnect gateway credentials or base URL.' };
  }
}

/** Raw tier header if present (even empty, which narrows to no tools); undefined if absent. */
function tierHeader(req: IncomingMessage): string | undefined {
  const raw = req.headers[TOOL_TIERS_HEADER];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw.join(',') : raw;
}

export async function startHttpServer(config: HttpConfig = resolveHttpConfig()): Promise<Server> {
  if (config.authMode === 'gateway') lockGatewayMode();
  const toolset = getDefaultToolset();

  const httpServer = createHttpServer(async (req, res) => {
    // A target such as "//h:99999/" makes new URL() throw. Caught here, before
    // any await, so it is a 400 rather than an unhandled rejection.
    let pathname: string;
    try {
      pathname = new URL(req.url || '/', 'http://localhost').pathname;
    } catch {
      sendJson(res, 400, { error: 'Bad request target.' });
      return;
    }

    if (pathname === '/health') {
      // Liveness only: unauthenticated, reads no credentials.
      sendJson(res, 200, { status: 'ok', transport: 'http', mode: config.authMode, timestamp: new Date().toISOString() });
      return;
    }
    if (pathname !== '/mcp') {
      sendJson(res, 404, { error: 'Not found', endpoints: ['/mcp', '/health'] });
      return;
    }
    if (!hostAllowed(req, config.allowedHosts)) {
      sendJson(res, 403, { error: 'Forbidden: Host header is not in MCP_ALLOWED_HOSTS.' });
      return;
    }
    if (config.s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), config.s2sSecret)) {
      sendJson(res, 401, { error: 'Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.' });
      return;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this server is stateless; use POST.' }, id: null });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: `Request body exceeds ${MAX_BODY_BYTES} bytes.` });
        req.destroy();
      } else {
        sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      }
      return;
    }

    const handle = async () => {
      // Must stay stateless (no session id, JSON responses): the tool call has
      // to finish inside this request's credential context. A stateful/SSE
      // transport could serve later messages under a stale tenant context.
      const requested = tierHeader(req);
      const tiers = narrowTiers(toolset.tiers, requested);
      if (requested !== undefined && tiers.size < toolset.tiers.size) {
        logger.debug('Tool tiers narrowed by header', { configured: [...toolset.tiers], effective: [...tiers] });
      }
      const server = createServer(toolsetForTiers(tiers));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    };

    try {
      if (config.authMode === 'gateway') {
        const { creds, status, error } = gatewayCredentials(req);
        if (!creds) {
          sendJson(res, status ?? 401, { error });
          return;
        }
        await runWithCredentials(creds, handle);
        return;
      }
      await handle();
    } catch (err) {
      logger.error('Unhandled MCP request error', { errorType: err instanceof Error ? err.constructor.name : typeof err });
      sendJson(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off('error', onError);
      logger.info(`HTTP streaming server listening on ${config.host}:${config.port}`, {
        mode: config.authMode,
        tiers: [...toolset.tiers],
        tools: toolset.tools.length,
        hostAllowlist: config.allowedHosts ? config.allowedHosts.size : 'off',
      });
      resolve();
    });
  });

  return httpServer;
}

// Vitest imports this module to call startHttpServer; skip the CLI entrypoint there.
if (process.env.VITEST !== 'true') {
  if (process.env.MCP_TRANSPORT === 'http') {
    try {
      const config = resolveHttpConfig();
      getDefaultToolset();
      startHttpServer(config).catch((error: unknown) => {
        logger.error('Fatal startup error', { error: error instanceof Error ? error.message : String(error) });
        process.exit(1);
      });
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  } else {
    await import('./index.js');
  }
}
