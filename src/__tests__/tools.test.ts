import { expect, it, vi } from 'vitest';
import { buildToolset, ALL_TOOL_DEFS } from '../tools/index.js';
import { CREDS, mockApi, SESSION, SID, textOf } from './helpers.js';
const all = () => buildToolset(new Set(['read', 'write', 'admin']));
const call = (name: string, args: Record<string, unknown> = {}) => all().dispatch(`screenconnect_${name}`, args);
it.each([
  ['sessions_search', {}, 'GetSessionsByFilter', [], [SESSION]],
  ['sessions_list_online', {}, 'GetSessionsByFilter', ["SessionType = 'Access' AND GuestConnectedCount > 0"], [SESSION]],
  ['sessions_get_by_name', { name: 'ENDPOINT-01' }, 'GetSessionsByName', ['ENDPOINT-01'], [SESSION]],
  ['session_get', { sessionId: SID }, 'GetSessionBySessionID', [SID], SESSION],
  ['session_get_details', { sessionId: SID }, 'GetSessionDetailsBySessionID', [SID], { Session: SESSION, Events: [], Connections: [] }],
  ['session_get_guest_info', { sessionId: SID }, 'GetSessionBySessionID', [SID], SESSION],
  ['session_add_note', { sessionId: SID, note: 'Example note' }, 'AddNoteToSession', [SID, 'Example note'], null],
  ['session_send_message', { sessionId: SID, message: 'Hello' }, 'SendMessageToSession', [SID, 'MCP', 'Hello'], null],
  ['session_update_name', { sessionId: SID, name: 'ENDPOINT-02' }, 'UpdateSessionName', [SID, 'ENDPOINT-02'], null],
  ['session_send_command', { sessionId: SID, commandText: 'echo hello', confirm: true }, 'SendCommandToSession', [SID, 'echo hello'], null],
  ['session_send_toolbox_item', { sessionId: SID, toolboxItemName: 'Diagnostics', confirm: true }, 'SendToolboxItemToSession', [SID, 'Diagnostics'], null],
  ['session_create', { type: 'Access', name: 'ENDPOINT-01', confirm: true }, 'CreateSession', [2, 'ENDPOINT-01', false, '', []], SID],
] as const)('%s happy path', async (name, args, method, expected, response) => {
  const spy = mockApi((m, a) => { expect(m).toBe(method); if (expected.length) expect(a).toEqual(expected); return response; });
  expect((await call(name, args)).isError).not.toBe(true); expect(spy).toHaveBeenCalledTimes(1);
});
it('merges all eight custom properties and preserves unspecified values', async () => {
  const spy = mockApi((m, args) => {
    if (m === 'GetSessionBySessionID') return [SESSION];
    expect(m).toBe('UpdateSessionCustomProperties'); expect(args).toEqual([SID, ['Example Co', '', 'new', '', '', '', '', '']]); return null;
  });
  const result = await call('session_update_custom_properties', { sessionId: SID, customProperties: { '2': '', '3': 'new' } });
  expect(result.isError).not.toBe(true); expect(spy).toHaveBeenCalledTimes(2);
});
it.each([SESSION, [SESSION]])('handles object and single-list session responses', async response => { mockApi(() => response); expect(textOf(await call('session_get', { sessionId: SID }))).toContain('ENDPOINT-01'); });
it.each([[], null, {}])('handles an empty session response', async response => { mockApi(() => response); expect(textOf(await call('session_get', { sessionId: SID }))).toContain('not found'); });
it.each(ALL_TOOL_DEFS.filter(d => d.tool.inputSchema.properties?.sessionId).map(d => [d.tool.name]))('%s rejects invalid GUID before upstream', async name => {
  const spy = mockApi(); const result = await all().dispatch(name, { sessionId: '../bad', confirm: true, commandText: 'echo', name: 'ENDPOINT-01', note: 'note', message: 'hello', toolboxItemName: 'Diagnostics', customProperties: {} });
  expect(result.isError).toBe(true); expect(spy).not.toHaveBeenCalled();
});
it('paginates client-side with total count and optional raw', async () => { mockApi(() => [SESSION, { ...SESSION, Name: 'ENDPOINT-02' }]); const r = JSON.parse(textOf(await call('sessions_search', { offset: 1, limit: 1, includeRaw: true }))); expect(r.totalCount).toBe(2); expect(r.items[0].raw.Name).toBe('ENDPOINT-02'); });
it('sorts events newest-first, filters integer types and preserves detail fields', async () => {
  mockApi(() => ({ Session: SESSION, Connections: [{ Host: 'jsmith' }], Other: true, Events: [{ EventType: 70, Time: '2026-01-01T00:00:00Z', Data: 'old' }, { EventType: 20, Time: '2026-01-03T00:00:00Z' }, { EventType: 70, Time: '2026-01-02T00:00:00Z', Data: 'new' }] }));
  const r = JSON.parse(textOf(await call('session_get_details', { sessionId: SID, eventTypes: [70], limit: 1 })));
  expect(r.events[0].data).toBe('new'); expect(r.totalEvents).toBe(2); expect(r.details.Other).toBe(true); expect(r.connections).toHaveLength(1);
});
it('derives guest uptime and online flag', async () => { mockApi(() => SESSION); const r = JSON.parse(textOf(await call('session_get_guest_info', { sessionId: SID }))); expect(r.online).toBe(true); expect(r.uptimeSeconds).toBeGreaterThan(0); expect(r.guestInfo.loggedOnUserName).toBe('jsmith'); });
it('polls for new EventType 70 output and builds PowerShell timeout directives', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-02T00:00:00Z')); let polls = 0;
  const spy = mockApi((m, args) => {
    if (m === 'SendCommandToSession') { expect(args[1]).toBe('#!ps\n#timeout=30000\nWrite-Output hello'); return null; }
    return { Events: [{ EventType: 70, Time: '2026-01-01T00:00:00Z', Data: 'old' }, ...( ++polls > 1 ? [{ EventType: 70, Time: new Date().toISOString(), Data: 'hello' }] : [])] };
  });
  const pending = call('session_send_command', { sessionId: SID, commandText: 'Write-Output hello', shell: 'powershell', timeoutSeconds: 30, waitForOutputSeconds: 5, confirm: true });
  await vi.advanceTimersByTimeAsync(1000); const r = JSON.parse(textOf(await pending)); expect(r.output).toBe('hello'); expect(spy).toHaveBeenCalledTimes(3);
});
it('reports output timeout without resending', async () => {
  vi.useFakeTimers(); const spy = mockApi(m => m === 'SendCommandToSession' ? null : { Events: [] });
  const pending = call('session_send_command', { sessionId: SID, commandText: 'echo', waitForOutputSeconds: 1, confirm: true }); await vi.advanceTimersByTimeAsync(1000);
  expect(textOf(await pending)).toContain('timedOut'); expect(spy.mock.calls.filter(([u]) => u.pathname.endsWith('SendCommandToSession'))).toHaveLength(1);
});
it('redacts secrets from raw output, errors, and logs', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {}); vi.stubEnv('LOG_LEVEL', 'debug');
  mockApi(() => ({ ...SESSION, Name: CREDS.apiSecret })); expect(textOf(await call('session_get', { sessionId: SID, includeRaw: true }))).not.toContain(CREDS.apiSecret);
  await call('session_get', { sessionId: CREDS.apiSecret }); expect(JSON.stringify(log.mock.calls)).not.toContain(CREDS.apiSecret);
});
it.each([{ limit: 501 }, { offset: -1 }, { includeRaw: 'yes' }, { onlineOnly: 'yes' }, { customProperties: { '9': 'bad' } }, { name: 'x'.repeat(1001) }])('validates search inputs before upstream', async args => { const spy = mockApi(); expect((await call('sessions_search', args)).isError).toBe(true); expect(spy).not.toHaveBeenCalled(); });
