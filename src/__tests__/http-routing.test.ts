// Exercise HTTP routing without opening sockets or contacting any host.
import { Readable } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
const state = vi.hoisted(() => ({ handler: undefined as undefined | ((req: unknown, res: unknown) => Promise<void>), response: undefined as unknown, toolNames: [] as string[] }));
vi.mock('node:http', () => ({ createServer: (handler: typeof state.handler) => {
  state.handler = handler;
  return { once: vi.fn(), off: vi.fn(), listen: (_port: number, _host: string, cb: () => void) => cb() };
} }));
vi.mock('../server.js', () => ({ createServer: (toolset: { tools: { name: string }[] }) => { state.toolNames = toolset.tools.map(t => t.name); return { connect: async () => {}, close: async () => {} }; } }));
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({ StreamableHTTPServerTransport: class {
  async close() {}
  async handleRequest() { const { resolveCredentials } = await import('../client.js'); state.response = resolveCredentials(); }
} }));
import { startHttpServer } from '../http.js';
const secret = 'test-only-s2s-value-0123456789abcdef';
function proof() { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`t=${t}`).digest('hex')}`; }
const vendor = { 'x-screenconnect-base-url': 'https://sc-eval.screenconnect.com', 'x-screenconnect-api-secret': 'eval-secret-not-real-0000' };
async function request(url = '/mcp', headers: Record<string, string> = {}, method = 'POST', body = '{}') {
  const req = Object.assign(Readable.from([Buffer.from(body)]), { url, method, headers: { host: 'localhost', ...headers } });
  const res = { headersSent: false, status: 0, body: '', writeHead(status: number) { this.status = status; this.headersSent = true; }, end(body: string) { this.body = body; }, setHeader: vi.fn(), on: vi.fn() };
  await state.handler!(req, res); return res;
}
beforeEach(async () => { state.response = undefined; state.toolNames = []; await startHttpServer({ authMode: 'gateway', host: '127.0.0.1', port: 8080, s2sSecret: secret, allowedHosts: new Set(['localhost']) }); });
it('health works without auth and reads no credentials', async () => { const res = await request('/health', {}, 'GET'); expect(res.status).toBe(200); expect(state.response).toBeUndefined(); });
it('rejects unauthenticated requests before reading vendor credentials', async () => { expect((await request('/mcp', vendor)).status).toBe(401); expect(state.response).toBeUndefined(); });
it('gateway never falls back to env creds when headers are missing', async () => { expect((await request('/mcp', { 'x-gateway-s2s': proof() })).status).toBe(401); expect(state.response).toBeUndefined(); });
it('accepts signed request-scoped headers including optional origin and extension', async () => {
  await request('/mcp', { ...vendor, 'x-gateway-s2s': proof(), 'x-screenconnect-origin': 'https://portal.screenconnect.com', 'x-screenconnect-extension-id': '11111111-2222-4333-8444-555555555555' });
  expect(state.response).toMatchObject({ apiSecret: vendor['x-screenconnect-api-secret'], origin: 'https://portal.screenconnect.com', extensionId: '11111111-2222-4333-8444-555555555555' }); expect(state.toolNames).toHaveLength(7);
});
it('header tier requests never widen read-only tools', async () => { await request('/mcp', { ...vendor, 'x-gateway-s2s': proof(), 'x-conduit-tool-tiers': 'read,write,admin' }); expect(state.toolNames).toHaveLength(7); });
it('present empty tier header removes all tools', async () => { await request('/mcp', { ...vendor, 'x-gateway-s2s': proof(), 'x-conduit-tool-tiers': '' }); expect(state.toolNames).toHaveLength(0); });
it('rejects private base URLs despite env escape hatch', async () => { vi.stubEnv('SCREENCONNECT_ALLOW_PRIVATE_BASE_URL', '1'); expect((await request('/mcp', { ...vendor, 'x-screenconnect-base-url': 'https://127.0.0.1', 'x-gateway-s2s': proof() })).status).toBe(400); });
it('enforces allowed hosts', async () => { expect((await request('/mcp', { ...vendor, host: 'other.screenconnect.com', 'x-gateway-s2s': proof() })).status).toBe(403); });
it('caps request bodies before SDK transport', async () => { expect((await request('/mcp', { ...vendor, 'x-gateway-s2s': proof(), 'content-length': '1048577' })).status).toBe(413); expect(state.response).toBeUndefined(); });
it('returns parse errors and rejects unsupported methods', async () => { expect((await request('/mcp', { ...vendor, 'x-gateway-s2s': proof() }, 'POST', '{')).status).toBe(400); expect((await request('/mcp', { 'x-gateway-s2s': proof() }, 'GET')).status).toBe(405); });
