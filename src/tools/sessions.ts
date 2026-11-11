import { setTimeout as sleep } from 'node:timers/promises';
import { callApi } from '../client.js';
import { currentAbortSignal, runWithAbortSignal } from '../egress.js';
import { buildFilter, customProperties, SESSION_TYPES } from '../filter.js';
import { ArgumentError, ScreenConnectApiError, ScreenConnectNotFoundError, type ScreenConnectCredentials } from '../types.js';
import { optionalBool, optionalEnum, optionalInt, requiredEnum, requiredId, requiredString } from '../validate.js';
import type { ToolArgs, ToolDef } from './types.js';

type Obj = Record<string, unknown>;
export const object = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const camel = (v: Obj): Obj => Object.fromEntries(Object.entries(v).map(([k, value]) => [k[0].toLowerCase() + k.slice(1), value]));
export function timestamp(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const dotnet = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(v);
  return dotnet ? Number(dotnet[1]) : Date.parse(v);
}
export function online(s: Obj): boolean {
  if (typeof s.GuestConnectedCount === 'number') return s.GuestConnectedCount > 0;
  return array(s.ActiveConnections).some(c => object(c).ProcessType === 2 || object(c).ProcessType === 'Guest');
}
export function summary(v: unknown, raw = false): Obj {
  const s = object(v), g = object(s.GuestInfo);
  return { sessionId: s.SessionID, name: s.Name, sessionType: typeof s.SessionType === 'number' ? SESSION_TYPES[s.SessionType] ?? s.SessionType : s.SessionType, online: online(s), networkAddress: s.GuestNetworkAddress, customPropertyValues: s.CustomPropertyValues, machineName: g.MachineName, serialNumber: g.MachineSerialNumber, loggedOnUser: g.LoggedOnUserName, operatingSystem: g.OperatingSystemName, ...(raw ? { raw: s } : {}) };
}
async function session(c: ScreenConnectCredentials, id: string): Promise<Obj> {
  const result = await callApi(c, 'GetSessionBySessionID', [id]);
  const s = object(Array.isArray(result) ? result[0] : result);
  if (!Object.keys(s).length) throw new ScreenConnectNotFoundError('Session not found.');
  return s;
}
const str = (maxLength = 1000) => ({ type: 'string', maxLength });
const bool = { type: 'boolean' };
const id = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' };
const type = { type: 'string', enum: SESSION_TYPES };
const props = { type: 'object', properties: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i + 1), str()])), additionalProperties: false };
const paging = { limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 }, offset: { type: 'integer', minimum: 0, default: 0 }, includeRaw: bool };
const search = { sessionType: type, name: str(), machineName: str(), serialNumber: str(), loggedOnUser: str(), operatingSystem: str(), customProperties: props, onlineOnly: bool, filter: str(4000), ...paging };
const rawFlag = (a: ToolArgs) => optionalBool(a, 'includeRaw') ?? false;
function page(v: unknown, a: ToolArgs): Obj {
  if (!Array.isArray(v)) throw new ScreenConnectApiError('Expected a ScreenConnect session list.');
  const offset = optionalInt(a, 'offset', { min: 0, max: Number.MAX_SAFE_INTEGER }) ?? 0;
  const limit = optionalInt(a, 'limit', { min: 1, max: 500 }) ?? 50;
  return { totalCount: v.length, offset, limit, items: v.slice(offset, offset + limit).map(s => summary(s, rawFlag(a))) };
}
function def(name: string, tier: ToolDef['tier'], description: string, properties: Obj, required: string[], handler: ToolDef['handler'], idempotent = false): ToolDef {
  return { tier, tool: { name: `screenconnect_${name}`, description: tier === 'admin' ? `⚠ HIGH-IMPACT: ${description} Requires confirm: true after explicit user confirmation.` : description, inputSchema: { type: 'object', properties: { ...properties, ...(tier === 'admin' ? { confirm: { type: 'boolean', const: true } } : {}) }, required: [...required, ...(tier === 'admin' ? ['confirm'] : [])], additionalProperties: false }, annotations: { readOnlyHint: tier === 'read', destructiveHint: tier === 'admin', idempotentHint: tier === 'read' || idempotent, openWorldHint: true } }, handler };
}
function text(a: ToolArgs, key: string, max = 1000): string { return requiredString(a, key, { max }); }
function validatePaging(a: ToolArgs): void { optionalInt(a, 'limit', { min: 1, max: 500 }); optionalInt(a, 'offset', { min: 0, max: Number.MAX_SAFE_INTEGER }); rawFlag(a); }
async function list(c: ScreenConnectCredentials, method: string, value: string, a: ToolArgs): Promise<Obj> { validatePaging(a); return page(await callApi(c, method, [value]), a); }
export const SESSION_TOOLS: ToolDef[] = [
  def('sessions_search', 'read', 'Search sessions using safely quoted structured fields or an exclusive advanced raw filter. Pagination is client-side.', search, [], async (a, c) => list(c, 'GetSessionsByFilter', buildFilter(a), a)),
  def('sessions_list_online', 'read', 'List connected guest sessions. Session type defaults to Access.', { sessionType: type, ...paging }, [], async (a, c) => list(c, 'GetSessionsByFilter', buildFilter({ sessionType: optionalEnum(a, 'sessionType', SESSION_TYPES) ?? 'Access', onlineOnly: true }), a)),
  def('sessions_get_by_name', 'read', 'Find sessions by exact name.', { name: str(), ...paging }, ['name'], async (a, c) => list(c, 'GetSessionsByName', text(a, 'name'), a)),
  def('session_get', 'read', 'Get one session by GUID.', { sessionId: id, includeRaw: bool }, ['sessionId'], async (a, c) => { const raw = rawFlag(a); return summary(await session(c, requiredId(a, 'sessionId')), raw); }),
  def('session_get_details', 'read', 'Get connections and newest-first events. Unknown detail fields are preserved in details; includeRaw returns the original payload.', { sessionId: id, eventTypes: { type: 'array', maxItems: 100, items: { type: 'integer' } }, limit: paging.limit, includeRaw: bool }, ['sessionId'], async (a, c) => {
    const sid = requiredId(a, 'sessionId'); const limit = optionalInt(a, 'limit', { min: 1, max: 500 }) ?? 50; const raw = rawFlag(a);
    if (a.eventTypes !== undefined && (!Array.isArray(a.eventTypes) || a.eventTypes.length > 100 || a.eventTypes.some(v => !Number.isInteger(v)))) throw new ArgumentError('eventTypes must contain at most 100 integers.');
    const d = object(await callApi(c, 'GetSessionDetailsBySessionID', [sid]));
    const events = array(d.Events).map(object).filter(e => !a.eventTypes || (a.eventTypes as number[]).includes(Number(e.EventType))).sort((x, y) => (timestamp(y.Time) || 0) - (timestamp(x.Time) || 0));
    const { Events: _events, Connections: _connections, Session: _session, ...rest } = d;
    return { session: summary(d.Session), connections: d.Connections ?? [], events: events.slice(0, limit).map(camel), totalEvents: events.length, details: rest, ...(raw ? { raw: d } : {}) };
  }),
  def('session_get_guest_info', 'read', 'Get guest inventory, online state and derived uptimeSeconds (null when unavailable).', { sessionId: id, includeRaw: bool }, ['sessionId'], async (a, c) => {
    const raw = rawFlag(a); const s = await session(c, requiredId(a, 'sessionId')); const g = object(s.GuestInfo); const boot = timestamp(g.LastBootTime);
    return { sessionId: s.SessionID, guestInfo: camel(g), online: online(s), uptimeSeconds: Number.isFinite(boot) && boot <= Date.now() ? Math.floor((Date.now() - boot) / 1000) : null, ...(raw ? { raw: g } : {}) };
  }),
  def('session_add_note', 'write', 'Add a note to a session. Never retried.', { sessionId: id, note: str(8000) }, ['sessionId', 'note'], async (a, c) => { await callApi(c, 'AddNoteToSession', [requiredId(a, 'sessionId'), text(a, 'note', 8000)]); return { success: true }; }),
  def('session_send_message', 'write', 'Send a guest message. byHost defaults to MCP. Never retried.', { sessionId: id, byHost: str(255), message: str(8000) }, ['sessionId', 'message'], async (a, c) => { const byHost = a.byHost === undefined ? 'MCP' : text(a, 'byHost', 255); await callApi(c, 'SendMessageToSession', [requiredId(a, 'sessionId'), byHost, text(a, 'message', 8000)]); return { success: true }; }),
  def('session_update_name', 'write', 'Rename a session. Never retried.', { sessionId: id, name: str() }, ['sessionId', 'name'], async (a, c) => { await callApi(c, 'UpdateSessionName', [requiredId(a, 'sessionId'), text(a, 'name')]); return { success: true }; }, true),
  def('session_update_custom_properties', 'write', 'Read-modify-write: merge partial slots 1..8 with current values, then replace all eight. Concurrent edits may be lost. Empty strings clear slots.', { sessionId: id, customProperties: props }, ['sessionId', 'customProperties'], async (a, c) => {
    const sid = requiredId(a, 'sessionId'); const updates = customProperties(a.customProperties); const s = await session(c, sid);
    if (s.CustomPropertyValues !== undefined && (!Array.isArray(s.CustomPropertyValues) || s.CustomPropertyValues.length > 8 || s.CustomPropertyValues.some(v => typeof v !== 'string'))) throw new ScreenConnectApiError('Invalid current custom properties; refusing to overwrite.');
    const current = Array.from({ length: 8 }, (_, i) => array(s.CustomPropertyValues)[i] ?? '');
    for (const [slot, value] of Object.entries(updates)) current[Number(slot) - 1] = value;
    await callApi(c, 'UpdateSessionCustomProperties', [sid, current]); return { success: true, customPropertyValues: current };
  }),
  def('session_send_command', 'admin', 'Execute a remote command. Non-idempotent, never retried. Optional output polling uses new EventType 70 events; concurrent commands cannot be reliably correlated.', { sessionId: id, commandText: str(8000), shell: { type: 'string', enum: ['cmd', 'powershell'], default: 'cmd' }, timeoutSeconds: { type: 'integer', minimum: 1, maximum: 3600 }, waitForOutputSeconds: { type: 'integer', minimum: 0, maximum: 60, default: 0 } }, ['sessionId', 'commandText'], async (a, c) => {
    const sid = requiredId(a, 'sessionId'); const command = text(a, 'commandText', 8000); const shell = optionalEnum(a, 'shell', ['cmd', 'powershell']) ?? 'cmd';
    const timeout = optionalInt(a, 'timeoutSeconds', { min: 1, max: 3600 }); const wait = optionalInt(a, 'waitForOutputSeconds', { min: 0, max: 60 }) ?? 0;
    const started = Date.now();
    await callApi(c, 'SendCommandToSession', [sid, `${shell === 'powershell' ? '#!ps\n' : ''}${timeout === undefined ? '' : `#timeout=${timeout * 1000}\n`}${command}`]);
    if (!wait) return { sent: true, output: null };
    const deadline = Date.now() + wait * 1000;
    const timeoutSignal = AbortSignal.timeout(wait * 1000);
    const caller = currentAbortSignal();
    const signal = caller ? AbortSignal.any([timeoutSignal, caller]) : timeoutSignal;
    do {
      let d: Obj;
      try { d = object(await runWithAbortSignal(signal, () => callApi(c, 'GetSessionDetailsBySessionID', [sid]))); }
      catch { return { sent: true, output: null, timedOut: timeoutSignal.aborted, pollingError: !timeoutSignal.aborted, message: 'Command was sent; output polling failed. Do not resend automatically.' }; }
      const events = array(d.Events).map(object).filter(e => Number(e.EventType) === 70 && timestamp(e.Time) >= started).sort((x, y) => timestamp(x.Time) - timestamp(y.Time));
      if (events.length) return { sent: true, output: events[0].Data, event: camel(events[0]), correlation: 'Timestamp only; another command may have produced this event.' };
      if (Date.now() >= deadline) break;
      try { await sleep(Math.min(1000, deadline - Date.now()), undefined, { signal }); }
      catch { return { sent: true, output: null, timedOut: timeoutSignal.aborted, cancelled: caller?.aborted ?? false }; }
    } while (Date.now() < deadline);
    return { sent: true, output: null, timedOut: true };
  }),
  def('session_send_toolbox_item', 'admin', 'Run a toolbox item on a remote endpoint. Never retried.', { sessionId: id, toolboxItemName: str() }, ['sessionId', 'toolboxItemName'], async (a, c) => { await callApi(c, 'SendToolboxItemToSession', [requiredId(a, 'sessionId'), text(a, 'toolboxItemName')]); return { sent: true }; }),
  def('session_create', 'admin', 'Create a Support, Meeting or Access session. Never retried.', { type, name: str(), isPublic: bool, code: str(255), customPropertyValues: { type: 'array', maxItems: 8, items: str() } }, ['type', 'name'], async (a, c) => {
    const t = requiredEnum(a, 'type', SESSION_TYPES); const name = text(a, 'name'); const isPublic = optionalBool(a, 'isPublic') ?? false;
    const code = a.code === undefined || a.code === '' ? '' : text(a, 'code', 255);
    const values = a.customPropertyValues ?? [];
    if (!Array.isArray(values) || values.length > 8 || values.some(v => typeof v !== 'string' || v.length > 1000)) throw new ArgumentError('customPropertyValues must contain up to eight strings, each at most 1000 characters.');
    const result = await callApi(c, 'CreateSession', [SESSION_TYPES.indexOf(t), name, isPublic, code, values]);
    return { sessionId: result };
  }),
];
