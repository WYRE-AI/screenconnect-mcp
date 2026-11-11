import { vi } from 'vitest';
import { setTransport } from '../egress.js';
export const SID = '11111111-2222-4333-8444-555555555555';
export const CREDS = { baseUrl: 'https://sc-eval.screenconnect.com', apiSecret: 'eval-secret-not-real-0000' };
export const SESSION = { Name: 'ENDPOINT-01', SessionID: SID, SessionType: 2, ActiveConnections: [{ ProcessType: 2 }], CustomPropertyValues: ['Example Co', 'keep'], GuestInfo: { MachineName: 'ENDPOINT-01', LoggedOnUserName: 'jsmith', LastBootTime: '2026-01-01T00:00:00Z' } };
export function mockApi(fn: (method: string, args: unknown[]) => unknown = () => SESSION) {
  const mock = vi.fn(async (url: URL, init: { body?: string }) => {
    const value = await fn(url.pathname.split('/').at(-1)!, JSON.parse(init.body ?? '[]'));
    return value instanceof Response ? value : new Response(JSON.stringify(value));
  });
  setTransport(mock); return mock;
}
export const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
