import { expect, it, vi } from 'vitest';
import { buildToolset } from '../tools/index.js';
import { mockApi, textOf } from './helpers.js';
const since = '2026-11-11T17:47:00Z';
const until = '2026-11-12T00:00:00Z';
const time = '2026-11-11T18:00:00Z';
const sessions = (n = 1) => Array.from({ length: n }, (_, i) => ({ SessionID: `11111111-2222-4333-8444-${String(i).padStart(12, '0')}`, Name: `ENDPOINT-${String(i + 1).padStart(2, '0')}`, GuestInfo: { MachineName: `ENDPOINT-${String(i + 1).padStart(2, '0')}` } }));
const event = (Data: unknown = 'echo hello', overrides = {}) => ({ EventType: 70, Time: time, Host: 'jsmith', Data, ...overrides });
const toolset = () => buildToolset(new Set(['read']));
async function hunt(args = {}, signal?: AbortSignal) {
  const result = await toolset().dispatch('screenconnect_hunt_campaign', { since, until, ...args }, signal);
  expect(result.isError, textOf(result)).not.toBe(true);
  return JSON.parse(textOf(result));
}
function fixture(events: unknown[] = [], n = 1, connections: unknown[] = []) {
  return mockApi(m => m === 'GetSessionsByFilter' ? sessions(n) : { Events: events, Connections: connections });
}
it('is available by default in the read tier without confirm', async () => {
  const tool = toolset().tools.find(t => t.name === 'screenconnect_hunt_campaign')!;
  expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  expect(tool.inputSchema.properties).not.toHaveProperty('confirm');
  fixture();
  expect((await hunt()).summary.flaggedSessions).toBe(0);
});
it.each(['Panel-Lateral.ps1', 'hxxps://sc[.]payproofkit[.]com', 'ns(dot)mo7sen{.}dev/EadF.php?p=4', 'hxxps[://]sc[dot]payproofkit(.)com'])('matches command data %s', async data => {
  fixture([event(data)]);
  const r = await hunt();
  expect(r.findings.some((f: any) => f.type === 'ioc_match')).toBe(true);
  expect(r.summary.flaggedSessions).toBe(1);
  expect(r.summary.earliestHit).toBe('2026-11-11T18:00:00.000Z');
});
it('enforces IP digit boundaries and whole-word operator matching', async () => {
  fixture([event('185.99.255.281 1185.99.255.28 NotAddmin AddminExtra screen')]);
  expect((await hunt()).summary.flaggedSessions).toBe(0);
});
it('matches an IP with surrounding punctuation and an operator as a whole word', async () => {
  fixture([event('(185.99.255.28) actor=Addmin')]);
  expect((await hunt()).findings.filter((f: any) => f.type === 'ioc_match')).toHaveLength(2);
});
it.each([[5, 1], [4, 0]])('mass execution across %s distinct sessions produces %s cluster', async (n, expected) => {
  fixture([event('#!ps\n#timeout=1000\n#maxlength=2000\nWrite-Output HELLO')], n);
  const r = await hunt();
  expect(r.massExecutionClusters).toHaveLength(expected);
  expect(r.summary.flaggedSessions).toBe(expected ? n : 0);
  if (expected) {
    expect(r.massExecutionClusters[0]).toMatchObject({ normalizedSnippet: 'write-output hello', sessionCount: 5, kind: 'command', iocMatched: false });
    expect(r.findings.filter((f: any) => f.type === 'mass_execution')).toHaveLength(5);
  }
});
it('does not cluster five executions spread over more than the window', async () => {
  const list = sessions(5);
  mockApi((m, args) => m === 'GetSessionsByFilter' ? list : { Events: [event('echo hello', { Time: new Date(Date.parse(time) + list.findIndex(s => s.SessionID === args[0]) * 5 * 60000).toISOString() })] });
  expect((await hunt()).massExecutionClusters).toHaveLength(0);
});
it('repeated executions on one session cannot satisfy the distinct-session threshold', async () => {
  fixture(Array.from({ length: 5 }, () => event()));
  expect((await hunt()).massExecutionClusters).toHaveLength(0);
});
it('clusters toolbox names and tolerates string event types and .NET times', async () => {
  fixture([event({ Name: 'Diagnostics' }, { EventType: 'QueuedTool', Time: `/Date(${Date.parse(time)})/` })], 5);
  expect((await hunt()).massExecutionClusters[0]).toMatchObject({ kind: 'toolbox', sessionCount: 5, normalizedSnippet: 'diagnostics' });
});
it('detects a qualifying sliding window after an earlier outlier', async () => {
  const list = sessions(6);
  mockApi((m, args) => m === 'GetSessionsByFilter' ? list : { Events: [event('echo hello', { Time: args[0] === list[0].SessionID ? '2026-11-11T17:48:00Z' : '2026-11-11T18:10:00Z' })] });
  expect((await hunt()).massExecutionClusters[0].sessionCount).toBe(5);
});
it('enables case-insensitive unknown operator checks only when supplied', async () => {
  fixture([event()]);
  expect((await hunt({ knownOperators: ['JSMITH'] })).summary.flaggedSessions).toBe(0);
  expect((await hunt({ knownOperators: [] })).findings.some((f: any) => f.type === 'unknown_operator')).toBe(true);
  const r = await hunt();
  expect(r.summary.unknownOperatorCheck).toBe('skipped (no knownOperators)');
  expect(r.summary.flaggedSessions).toBe(0);
});
it('flags exact Addmin actor even when unknown checks are skipped', async () => {
  fixture([event('echo hello', { Host: undefined, Participant: 'aDDmin' })]);
  expect((await hunt()).findings.some((f: any) => f.type === 'ioc_operator')).toBe(true);
});
it('flags IOC host IP, host participant and nested connection events', async () => {
  fixture([], 1, [{ ProcessType: 1, ParticipantName: 'Addmin', NetworkAddress: '185.99.255.28', ConnectedTime: time, Events: [event('runnew.cmd', { Host: undefined })] }]);
  const r = await hunt({ knownOperators: ['jsmith'] });
  for (const type of ['ioc_ip_connection', 'ioc_operator', 'unknown_operator', 'command_event']) expect(r.findings.some((f: any) => f.type === type)).toBe(true);
});
it('matches screen only as an exact connection hostname or participant', async () => {
  fixture([], 1, [{ ProcessType: 'Host', ParticipantName: 'screen', ConnectedTime: time }]);
  expect((await hunt()).summary.flaggedSessions).toBe(1);
  fixture([event('screen ScreenConnect')]);
  expect((await hunt()).summary.flaggedSessions).toBe(0);
});
it('ignores connections outside the window and guest names for unknown operator checks', async () => {
  fixture([], 1, [{ ProcessType: 'Host', ParticipantName: 'Addmin', ConnectedTime: '2026-11-10T00:00:00Z', DisconnectedTime: '2026-11-10T01:00:00Z' }, { ProcessType: 2, ParticipantName: 'guest', ConnectedTime: time }]);
  expect((await hunt({ knownOperators: [] })).summary.flaggedSessions).toBe(0);
});
it('scans list inventory and reports fields, marks sqlite low confidence, accepts extra IOCs', async () => {
  mockApi(m => m === 'GetSessionsByFilter' ? [{ ...sessions()[0], CustomPropertyValues: ['sqlite3.exe'], ClientId: '2588ef5c15954b10', GuestNetworkAddress: '155.94.150.39', Name: 'custom-marker' }] : {});
  const r = await hunt({ extraIocs: ['custom-marker'] });
  expect(r.findings).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'CustomPropertyValues', severity: 'low' }), expect.objectContaining({ field: 'ClientId', iocKind: 'client_id' }), expect.objectContaining({ matchedIoc: 'custom-marker', severity: 'medium' })]));
});
it('uses one raw filter search as-is even with sessionType, and limits sessions', async () => {
  const spy = fixture([], 3);
  const r = await hunt({ maxSessions: 1, sessionFilter: 'Name LIKE *', sessionType: 'Support' });
  expect(r.summary).toMatchObject({ totalMatched: 3, sessionsScanned: 1, sessionsSkipped: 2, sessionsTruncated: true, partial: true, sessionFilter: 'Name LIKE *' });
  expect(spy).toHaveBeenCalledTimes(2);
  expect(JSON.parse(spy.mock.calls[0][1].body!)).toEqual(['Name LIKE *']);
});
it('returns partial results and counts details errors without failing the hunt', async () => {
  const list = sessions(2);
  mockApi((m, args) => {
    if (m === 'GetSessionsByFilter') return list;
    if (args[0] === list[0].SessionID) throw new Error('private transport error');
    return { Events: [event('runnew.cmd')] };
  });
  const r = await hunt();
  expect(r.summary).toMatchObject({ partial: true, errors: 1, sessionsScanned: 1, sessionsSkipped: 1, flaggedSessions: 1 });
  expect(JSON.stringify(r)).not.toContain('private transport error');
});
it('bounds concurrency to four and stops at the runtime budget even with a stuck transport', async () => {
  vi.useFakeTimers();
  vi.stubEnv('SCREENCONNECT_HUNT_BUDGET_MS', '5000');
  const spy = mockApi(m => m === 'GetSessionsByFilter' ? sessions(10) : new Promise(() => {}));
  const pending = hunt();
  await vi.advanceTimersByTimeAsync(5000);
  const r = await pending;
  expect(spy).toHaveBeenCalledTimes(5);
  expect(r.summary).toMatchObject({ partial: true, partialReason: 'runtime budget; details errors', sessionsScanned: 0, sessionsSkipped: 10, errors: 4 });
});
it('returns partial results on caller cancellation', async () => {
  const controller = new AbortController();
  mockApi(m => {
    if (m === 'GetSessionsByFilter') return sessions(6);
    controller.abort();
    return {};
  });
  const r = await hunt({}, controller.signal);
  expect(r.summary.partial).toBe(true);
  expect(r.summary.partialReason).toContain('caller aborted');
});
it('fails the hunt when the initial search fails', async () => {
  mockApi(() => { throw new Error('search failed'); });
  expect((await toolset().dispatch('screenconnect_hunt_campaign', { since, until })).isError).toBe(true);
});
it('clean commands are info only and earlier or later events are ignored', async () => {
  fixture([event(), event('runnew.cmd', { Time: '2026-11-10T00:00:00Z' }), event('runnew.cmd', { Time: '2026-11-13T00:00:00Z' })]);
  const r = await hunt();
  expect(r.summary).toMatchObject({ flaggedSessions: 0, findingsCount: 1, highSeverityCount: 0, earliestHit: null });
  expect(r.findings[0].severity).toBe('info');
});
it('sorts severities and truncates findings while preserving complete counts', async () => {
  fixture([event('sqlite3.exe runnew.cmd')]);
  const r = await hunt({ maxFindings: 1 });
  expect(r.findings).toHaveLength(1);
  expect(r.findings[0].severity).toBe('high');
  expect(r.summary).toMatchObject({ findingsCount: 3, findingsTruncated: 2, flaggedSessions: 1 });
});
it.each([{ since: 'bad' }, { since: '2026-02-30T00:00:00Z' }, { until: since }, { maxSessions: 5001 }, { maxSessions: '5' }, { massThreshold: 1 }, { maxFindings: 0 }, { extraIocs: ['xx'] }, { knownOperators: [1] }, { includeClean: 'yes' }, { surprise: true }, { sessionType: 'Other' }, { since: null }, { sessionFilter: null }])('strictly rejects invalid input %j before calls', async args => {
  const spy = fixture();
  expect((await toolset().dispatch('screenconnect_hunt_campaign', { since, until, ...args })).isError).toBe(true);
  expect(spy).not.toHaveBeenCalled();
});
