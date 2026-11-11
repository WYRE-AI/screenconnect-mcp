import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { normalizeBaseUrl } from './base-url.js';
import { allowPrivateBaseUrl, isGatewayMode, maxUpstreamBytes } from './config.js';
import { outboundFetch, outboundSignal, readBoundedText } from './egress.js';
import { ArgumentError, ScreenConnectApiError, ScreenConnectAuthError, type ScreenConnectCredentials } from './types.js';

export const DEFAULT_EXTENSION_ID = '2d558935-686a-4bd0-9991-07539f5fe749';
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const context = new AsyncLocalStorage<ScreenConnectCredentials>();
export class MissingCredentialsError extends Error {}
export function runWithCredentials<T>(creds: ScreenConnectCredentials, fn: () => T): T { return context.run(creds, fn); }
export function validateCredentials(creds: ScreenConnectCredentials, allowPrivate = false): ScreenConnectCredentials {
  const baseUrl = normalizeBaseUrl(creds.baseUrl, { allowPrivate });
  if (!creds.apiSecret || creds.apiSecret.length > 8192 || /[\r\n]/.test(creds.apiSecret)) throw new MissingCredentialsError('A valid SCREENCONNECT_API_SECRET is required.');
  const extensionId = creds.extensionId ?? DEFAULT_EXTENSION_ID;
  if (!GUID.test(extensionId)) throw new ArgumentError('SCREENCONNECT_EXTENSION_ID must be a GUID.');
  if (creds.origin !== undefined) {
    let url: URL;
    try { url = new URL(creds.origin); } catch { throw new ArgumentError('SCREENCONNECT_ORIGIN must be an HTTPS origin.'); }
    if (url.protocol !== 'https:' || url.origin !== creds.origin || creds.origin.length > 2048) throw new ArgumentError('SCREENCONNECT_ORIGIN must be an HTTPS origin.');
  }
  return { ...creds, baseUrl, extensionId };
}
export function resolveCredentials(): ScreenConnectCredentials {
  const scoped = context.getStore();
  if (scoped) return validateCredentials(scoped, !isGatewayMode() && allowPrivateBaseUrl());
  if (isGatewayMode()) throw new MissingCredentialsError('Gateway credentials are required; environment fallback is disabled.');
  return validateCredentials({ baseUrl: process.env.SCREENCONNECT_BASE_URL ?? '', apiSecret: process.env.SCREENCONNECT_API_SECRET ?? '', origin: process.env.SCREENCONNECT_ORIGIN || undefined, extensionId: process.env.SCREENCONNECT_EXTENSION_ID || undefined }, allowPrivateBaseUrl());
}
/** Known values for output/log hygiene, including validation failures. Never persisted. */
export function credentialSecrets(): string[] {
  const secret = context.getStore()?.apiSecret ?? (!isGatewayMode() ? process.env.SCREENCONNECT_API_SECRET : undefined);
  return secret ? [secret] : [];
}
const READ_METHODS = new Set(['GetSessionsByFilter', 'GetSessionsByName', 'GetSessionBySessionID', 'GetSessionDetailsBySessionID']);
const WRITE_METHODS = new Set(['AddNoteToSession', 'SendMessageToSession', 'UpdateSessionName', 'UpdateSessionCustomProperties', 'SendCommandToSession', 'SendToolboxItemToSession', 'CreateSession']);
export async function callApi(creds: ScreenConnectCredentials, method: string, args: unknown[]): Promise<unknown> {
  if (!READ_METHODS.has(method) && !WRITE_METHODS.has(method)) throw new ArgumentError('Unknown upstream method.');
  const validated = validateCredentials(creds, allowPrivateBaseUrl());
  const headers: Record<string, string> = { 'Content-Type': 'application/json', CTRLAuthHeader: validated.apiSecret };
  if (validated.origin) headers.Origin = validated.origin;
  const signal = outboundSignal(); // One bounded budget across attempts, body reads and delays.
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const res = await outboundFetch(`${validated.baseUrl}/App_Extensions/${validated.extensionId}/Service.ashx/${method}`, { method: 'POST', headers, body: JSON.stringify(args), signal });
    const text = await readBoundedText(res, maxUpstreamBytes(), method);
    if (READ_METHODS.has(method) && (res.status === 429 || res.status >= 500) && attempt < 2) {
      const retry = res.headers.get('retry-after');
      const seconds = retry === null ? NaN : Number(retry);
      const requested = retry === null ? 250 * 2 ** attempt : Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry) - Date.now();
      const delay = Math.max(0, Math.min(2000, Number.isFinite(requested) ? requested : 250));
      if (Date.now() - started + delay < 10_000) { await sleep(delay, undefined, { signal }); continue; }
    }
    if (res.status === 401 || res.status === 403) throw new ScreenConnectAuthError('ScreenConnect rejected the API secret (CTRLAuthHeader).', res.status);
    if (res.status === 404) throw new ScreenConnectApiError('RESTful API Manager extension not installed/enabled, or wrong extension ID.', 404);
    if (!res.ok) throw new ScreenConnectApiError(`ScreenConnect ${method} failed (HTTP ${res.status}).`, res.status);
    if (!text.trim()) return null;
    try { return JSON.parse(text); } catch { throw new ScreenConnectApiError('ScreenConnect returned invalid JSON.'); }
  }
}
