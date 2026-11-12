import { describe, expect, it, vi } from 'vitest';
import { callApi, DEFAULT_EXTENSION_ID, resolveCredentials, runWithCredentials } from '../client.js';
import { CREDS, mockApi } from './helpers.js';
import { setTransport } from '../egress.js';
describe('RESTful API Manager client', () => {
  it('uses positional POST JSON, CTRLAuthHeader and optional Origin without cookies', async () => {
    const spy = mockApi(() => []);
    await callApi({ ...CREDS, origin: 'https://portal.screenconnect.com' }, 'GetSessionsByFilter', ["Name = 'ENDPOINT-01'"]);
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe(`${CREDS.baseUrl}/App_Extensions/${DEFAULT_EXTENSION_ID}/Service.ashx/GetSessionsByFilter`);
    expect(init).toMatchObject({ method: 'POST', headers: { CTRLAuthHeader: CREDS.apiSecret, Origin: 'https://portal.screenconnect.com', 'Content-Type': 'application/json' }, body: JSON.stringify(["Name = 'ENDPOINT-01'"]) });
    await callApi(CREDS, 'GetSessionsByName', ['ENDPOINT-01']);
    expect(spy.mock.calls[1][1]).not.toHaveProperty('headers.Origin');
    expect(spy.mock.calls[0][1]).not.toHaveProperty('headers.Cookie');
  });
  it.each(['AddNoteToSession', 'SendMessageToSession', 'UpdateSessionName', 'UpdateSessionCustomProperties', 'SendCommandToSession', 'SendToolboxItemToSession', 'CreateSession'])('never retries write %s', async method => {
    const spy = mockApi(() => new Response('', { status: 503 }));
    await expect(callApi(CREDS, method, [])).rejects.toThrow('503'); expect(spy).toHaveBeenCalledTimes(1);
  });
  it('retries a throttled read honoring Retry-After', async () => {
    let n = 0; const spy = mockApi(() => ++n === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '0' } }) : []);
    expect(await callApi(CREDS, 'GetSessionsByFilter', [''])).toEqual([]); expect(spy).toHaveBeenCalledTimes(2);
  });
  it('bounds read retries and caps Retry-After delays', async () => {
    vi.useFakeTimers(); const spy = mockApi(() => new Response('', { status: 503, headers: { 'Retry-After': '999' } }));
    const result = expect(callApi(CREDS, 'GetSessionsByName', ['ENDPOINT-01'])).rejects.toThrow('503');
    await vi.runAllTimersAsync(); await result; expect(spy).toHaveBeenCalledTimes(3);
  });
  it.each([[401, 'secret'], [403, 'secret'], [404, 'extension']])('maps HTTP %s safely', async (status, message) => {
    mockApi(() => new Response(CREDS.apiSecret, { status: Number(status) }));
    await expect(callApi(CREDS, 'GetSessionsByName', ['ENDPOINT-01'])).rejects.toThrow(String(message));
  });
  it('fails closed on streamed oversized JSON before parsing', async () => {
    vi.stubEnv('SCREENCONNECT_MAX_UPSTREAM_BYTES', '10'); mockApi(() => ({ value: 'too large' }));
    await expect(callApi(CREDS, 'GetSessionsByFilter', [''])).rejects.toThrow('exceeded');
  });
  it('fails closed on declared oversized bodies', async () => {
    vi.stubEnv('SCREENCONNECT_MAX_UPSTREAM_BYTES', '10'); mockApi(() => new Response('{}', { headers: { 'Content-Length': '100' } }));
    await expect(callApi(CREDS, 'GetSessionsByFilter', [''])).rejects.toThrow('exceeded');
  });
  it('rejects invalid JSON', async () => { mockApi(() => new Response('{')); await expect(callApi(CREDS, 'GetSessionsByFilter', [''])).rejects.toThrow('invalid JSON'); });
  it('never falls back to environment credentials in gateway mode', () => { vi.stubEnv('AUTH_MODE', 'gateway'); expect(resolveCredentials).toThrow('fallback'); });
  it('isolates concurrent request credentials', async () => {
    vi.stubEnv('AUTH_MODE', 'gateway');
    await Promise.all(['one', 'two'].map(apiSecret => runWithCredentials({ ...CREDS, apiSecret }, async () => { await Promise.resolve(); expect(resolveCredentials().apiSecret).toBe(apiSecret); })));
  });
  it('rejects invalid extension IDs before transport', async () => { const spy = mockApi(); await expect(callApi({ ...CREDS, extensionId: '../bad' }, 'GetSessionsByFilter', [''])).rejects.toThrow('GUID'); expect(spy).not.toHaveBeenCalled(); });
  it('does not follow redirects', async () => { const spy = mockApi(() => new Response('', { status: 302, headers: { Location: 'https://other.screenconnect.com' } })); await expect(callApi(CREDS, 'GetSessionsByFilter', [''])).rejects.toThrow('302'); expect(spy).toHaveBeenCalledTimes(1); });
  it('does not expose transport error strings', async () => { setTransport(async () => { throw new Error(CREDS.apiSecret); }); await expect(callApi(CREDS, 'GetSessionsByFilter', [''])).rejects.toThrow(); });
});
