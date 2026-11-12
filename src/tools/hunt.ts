import { callApi } from '../client.js';
import { currentAbortSignal, runWithAbortSignal } from '../egress.js';
import { buildFilter, SESSION_TYPES } from '../filter.js';
import { CAMPAIGN_START, IOC_SET_VERSION, IOCS, type Ioc } from '../hunt/iocs.js';
import { ArgumentError, ScreenConnectApiError } from '../types.js';
import { object, timestamp } from './sessions.js';
import type { ToolArgs, ToolDef } from './types.js';

type Obj = Record<string, unknown>;
type Severity = Ioc['severity'] | 'info';
type Finding = {
  sessionId: string; sessionName: string; machineName: string; type: string; severity: Severity;
  matchedIoc?: string; iocKind?: string; eventType?: string; eventTime?: string;
  operator?: string; field?: string; snippet: string;
};
type Execution = { session: Obj; time: number; operator: string; text: string; kind: 'command' | 'toolbox'; iocMatched: boolean };
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const string = (v: unknown): string => typeof v === 'string' ? v : '';
const printable = (v: unknown): string => typeof v === 'string' ? v : JSON.stringify(v) ?? '';
const snippet = (v: string): string => v.replace(/\s+/g, ' ').slice(0, 300);
export function normalizeIoc(v: string): string {
  return v.toLowerCase().replace(/\[\.\]|\(\.\)|\{\.\}|\[dot\]|\(dot\)/g, '.')
    .replace(/hxxp/g, 'http').replace(/\[:\]/g, ':').replace(/\[:\/\/\]/g, '://');
}
function contains(text: string, ioc: Ioc): boolean {
  const needle = normalizeIoc(ioc.value);
  if (ioc.kind === 'hostname' && needle === 'screen') return false;
  if (ioc.kind === 'installer' && !text.includes('c=exploited')) return false;
  let pos = text.indexOf(needle);
  while (pos !== -1) {
    const before = text[pos - 1] ?? '';
    const after = text[pos + needle.length] ?? '';
    if (ioc.kind === 'ip' ? !/\d/.test(before) && !/\d/.test(after)
      : ioc.kind === 'operator' ? !/[\w]/.test(before) && !/[\w]/.test(after) : true) return true;
    pos = text.indexOf(needle, pos + needle.length);
  }
  return false;
}
const EVENT_TYPES: Record<string, string> = {
  1: 'DeletedEvent', 10: 'Connected', 11: 'Disconnected', 21: 'DeletedSession', 32: 'AddedNote',
  43: 'QueuedWake', 44: 'QueuedCommand', 45: 'QueuedMessage', 47: 'QueuedTool',
  48: 'QueuedForceDisconnect', 70: 'RanCommand', 100: 'QueuedUninstallAndDelete',
};
export const NEXT_STEPS = [
  'Do NOT open GUI/backstage sessions on flagged machines (campaign reverse-pivots onto tech workstations); use EDR live response or WinRM instead.',
  'Terminate all active web/host sessions and force sign-out of all users.',
  "Rotate all ScreenConnect credentials and the RESTful API Manager secret; verify MFA on every account and remove unknown users (e.g. 'Addmin').",
  'Remediate flagged endpoints: remove rogue ScreenConnect client service(s) (client IDs 2588ef5c15954b10, ed630cc2c873b091 or unknown instances), delete TrapWatch scheduled task, C:\\ProgramData\\RelayTrap\\, %TEMP%\\sckit-* folders, HKCU/HKLM Run value RelayTrapLiteAlert, and dropped sqlite3.exe; block IOC IPs/domains at the firewall/DNS filter.',
  'Review the ConnectWise security advisory and preserve logs before cleanup.',
];
export const COVERAGE_GAPS = [
  'Panel login history and the ScreenConnect audit log are NOT available through the RESTful API Manager extension; check Administration > Audit in the SC web UI and the ConnectWise advisory.',
  'Event/connection field names (Host, ParticipantName, NetworkAddress, ProcessType, event Data for toolbox items) are inferred from public prior art and unverified against a live instance.',
  "Endpoints with a rogue second ScreenConnect client that never connected to THIS instance won't show here; use EDR/RMM to search for the client IDs and file IOCs.",
];
const integer = (minimum: number, maximum: number, fallback: number) => ({ type: 'integer', minimum, maximum, default: fallback });
const listSchema = (maxItems: number, minLength: number, maxLength: number) => ({ type: 'array', maxItems, items: { type: 'string', minLength, maxLength } });
const properties = {
  since: { type: 'string', format: 'date-time', default: CAMPAIGN_START },
  until: { type: 'string', format: 'date-time' },
  sessionType: { type: 'string', enum: SESSION_TYPES, default: 'Access' },
  sessionFilter: { type: 'string', maxLength: 4000 },
  maxSessions: integer(1, 5000, 500), extraIocs: listSchema(200, 3, 500),
  knownOperators: listSchema(500, 0, 255), massThreshold: integer(2, 1000, 5),
  massWindowMinutes: integer(1, 1440, 15), maxFindings: integer(1, 5000, 500),
  includeClean: { type: 'boolean', default: false },
};
function int(a: ToolArgs, key: string, min: number, max: number, fallback: number): number {
  const value = a[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new ArgumentError(`${key} must be an integer between ${min} and ${max}.`);
  return value;
}
function strings(a: ToolArgs, key: string, maxItems: number, min: number, max: number): string[] | undefined {
  const value = a[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems || value.some(v => typeof v !== 'string' || v.length < min || v.length > max)) throw new ArgumentError(`Invalid ${key} array.`);
  return value as string[];
}
function iso(value: unknown, key: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) throw new ArgumentError(`${key} must be an ISO-8601 timestamp with timezone.`);
  // Date.parse normalizes impossible calendar dates; reject those before querying.
  const date = value.slice(0, 10);
  const day = Number(date.slice(8));
  const month = Number(date.slice(5, 7));
  const year = Number(date.slice(0, 4));
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new ArgumentError(`Invalid ${key} calendar date.`);
  return Date.parse(value);
}
function budgetMs(): number {
  const n = Number(process.env.SCREENCONNECT_HUNT_BUDGET_MS);
  return Number.isFinite(n) && n > 0 ? Math.max(5000, Math.min(600000, Math.floor(n))) : 120000;
}
function operatorName(e: Obj, fallback = ''): string {
  // These candidate fields are unverified against a live instance. ProcessType never filters event actors.
  const candidate = e.Host ?? e.Participant ?? e.ConnectionParticipantName ?? e.ParticipantName ?? e.Operator ?? e.HostName;
  return string(candidate) || string(object(candidate).ParticipantName) || string(object(candidate).Name) || fallback;
}
function commandText(e: Obj, kind: 'command' | 'toolbox'): string {
  const data = object(e.Data);
  return kind === 'toolbox' ? string(data.Name ?? data.ItemName ?? data.ToolboxItemName) || printable(e.Data)
    : string(data.CommandText ?? data.Command) || printable(e.Data);
}
function normalizeCommand(text: string): string {
  return text.replace(/^\s*#!ps\s*$/gim, '').replace(/^\s*#(?:timeout|maxlength)=[^\r\n]*$/gim, '').replace(/\s+/g, ' ').toLowerCase().trim();
}
/** Also bounds transports/body readers that do not settle promptly on cancellation. */
function bounded<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Hunt cancelled.'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    fn().then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function hunt(a: ToolArgs, creds: Parameters<typeof callApi>[0]) {
  const since = iso(a.since === undefined ? CAMPAIGN_START : a.since, 'since');
  const until = a.until === undefined ? Date.now() : iso(a.until, 'until');
  if (until <= since) throw new ArgumentError('until must be greater than since.');
  if (a.sessionType !== undefined && !SESSION_TYPES.includes(a.sessionType as typeof SESSION_TYPES[number])) throw new ArgumentError('Invalid sessionType.');
  if (a.sessionFilter !== undefined && (typeof a.sessionFilter !== 'string' || a.sessionFilter.length > 4000)) throw new ArgumentError('Invalid sessionFilter.');
  if (a.includeClean !== undefined && typeof a.includeClean !== 'boolean') throw new ArgumentError('includeClean must be a boolean.');
  const filter = a.sessionFilter as string | undefined ?? buildFilter({ sessionType: a.sessionType ?? 'Access' });
  const maxSessions = int(a, 'maxSessions', 1, 5000, 500);
  const maxFindings = int(a, 'maxFindings', 1, 5000, 500);
  const threshold = int(a, 'massThreshold', 2, 1000, 5);
  const window = int(a, 'massWindowMinutes', 1, 1440, 15) * 60000;
  const known = strings(a, 'knownOperators', 500, 0, 255);
  const knownSet = known && new Set(known.map(v => v.toLowerCase()));
  const extra = strings(a, 'extraIocs', 200, 3, 500) ?? [];
  const iocs: Ioc[] = [...IOCS, ...extra.map(value => ({ value, kind: 'extra', severity: 'medium' as const, note: 'User supplied substring IOC.' }))];
  const controller = new AbortController();
  const caller = currentAbortSignal();
  const signal = caller ? AbortSignal.any([controller.signal, caller]) : controller.signal;
  const deadline = Date.now() + budgetMs();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
  const findings: Finding[] = [];
  const executions: Execution[] = [];
  const errorSamples: string[] = [];
  let errors = 0;
  let scanned = 0;
  let cursor = 0;
  const inWindow = (t: number) => Number.isFinite(t) && t >= since && t <= until;
  function add(s: Obj, type: string, severity: Severity, text: string, context: Partial<Finding> = {}) {
    findings.push({ sessionId: string(s.SessionID), sessionName: string(s.Name), machineName: string(object(s.GuestInfo).MachineName), type, severity, snippet: snippet(text), ...context });
  }
  function scan(s: Obj, value: unknown, field: string, context: Partial<Finding> = {}): boolean {
    const text = printable(value);
    const normalized = normalizeIoc(text);
    let hit = false;
    for (const ioc of iocs) if (contains(normalized, ioc)) {
      hit = true;
      add(s, 'ioc_match', ioc.severity, text, { ...context, field, matchedIoc: ioc.value, iocKind: ioc.kind });
    }
    return hit;
  }
  function actor(s: Obj, name: string, context: Partial<Finding>) {
    if (!name) return;
    if (name.toLowerCase() === 'addmin') add(s, 'ioc_operator', 'high', name, { ...context, operator: name, matchedIoc: 'Addmin', iocKind: 'operator' });
    if (knownSet && !knownSet.has(name.toLowerCase())) add(s, 'unknown_operator', 'medium', name, { ...context, operator: name });
  }
  function event(s: Obj, v: unknown, fallback = '') {
    const e = object(v);
    const time = timestamp(e.Time);
    if (!inWindow(time)) return;
    const eventType = EVENT_TYPES[String(e.EventType)] ?? String(e.EventType ?? 'Unknown');
    const operator = operatorName(e, fallback);
    const context = { eventTime: new Date(time).toISOString(), eventType, operator };
    actor(s, operator, context);
    const kind = /command/i.test(eventType) ? 'command' : /tool/i.test(eventType) ? 'toolbox' : undefined;
    const hit = scan(s, e, 'Events', context);
    if (kind) {
      const text = commandText(e, kind);
      add(s, 'command_event', 'info', text, context);
      const normalized = normalizeCommand(text);
      if (normalized) executions.push({ session: s, time, operator, text: normalized, kind, iocMatched: hit });
    }
  }
  try {
    const result = await bounded(signal, () => runWithAbortSignal(signal, () => callApi(creds, 'GetSessionsByFilter', [filter])));
    if (!Array.isArray(result)) throw new ScreenConnectApiError('Expected a ScreenConnect session list.');
    const sessions = result.slice(0, maxSessions).map(object);
    for (const s of sessions) for (const [field, value] of Object.entries(s)) scan(s, value, field);
    async function worker() {
      while (cursor < sessions.length && !signal.aborted && Date.now() < deadline) {
        const s = sessions[cursor++];
        try {
          const d = object(await bounded(signal, () => runWithAbortSignal(signal, () => callApi(creds, 'GetSessionDetailsBySessionID', [s.SessionID]))));
          if (signal.aborted || Date.now() >= deadline) break;
          scanned++;
          for (const e of array(d.Events)) event(s, e);
          for (const v of array(d.Connections)) {
            const connection = object(v);
            const host = connection.ProcessType === 1 || String(connection.ProcessType).toLowerCase() === 'host' || connection.ProcessType === '1';
            const start = timestamp(connection.ConnectedTime);
            const end = timestamp(connection.DisconnectedTime);
            // Connections overlapping the window count; missing start times cannot establish coverage.
            if (Number.isFinite(start) && start <= until && (!Number.isFinite(end) || end >= since)) {
              const context = { eventTime: new Date(Math.max(start, since)).toISOString(), field: 'Connections' };
              if (host) {
                actor(s, string(connection.ParticipantName), context);
                for (const ioc of iocs.filter(i => i.kind === 'ip')) if (contains(normalizeIoc(string(connection.NetworkAddress)), ioc)) add(s, 'ioc_ip_connection', 'high', printable(connection), { ...context, matchedIoc: ioc.value, iocKind: ioc.kind });
              }
              const { Events: _events, ...fields } = connection;
              scan(s, fields, 'Connections', context);
              if (['Hostname', 'HostName', 'MachineName', 'ParticipantName'].some(k => string(connection[k]).toLowerCase() === 'screen')) add(s, 'ioc_match', 'high', printable(fields), { ...context, matchedIoc: 'screen', iocKind: 'hostname' });
            }
            for (const e of array(connection.Events)) event(s, e, host ? string(connection.ParticipantName) : '');
          }
        } catch {
          errors++;
          // Never include transport messages or upstream bodies, which can contain credentials.
          if (errorSamples.length < 5) errorSamples.push(`Details unavailable for session ${string(s.SessionID)}.`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, sessions.length) }, () => worker()));
    const groups = new Map<string, Execution[]>();
    for (const e of executions) {
      const key = `${e.kind}:${e.text}`;
      const group = groups.get(key) ?? [];
      group.push(e);
      groups.set(key, group);
    }
    const clusters = [];
    const massSessions = new Set<string>();
    for (const group of groups.values()) {
      group.sort((a, b) => a.time - b.time);
      const counts = new Map<string, number>();
      let right = 0;
      let previousEnd = -1;
      for (let left = 0; left < group.length; left++) {
        while (right < group.length && group[right].time - group[left].time <= window) {
          const id = string(group[right++].session.SessionID);
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
        // Emit maximal windows only, avoiding duplicates when advancing left keeps the same right edge.
        if (counts.size >= threshold && right !== previousEnd) {
          previousEnd = right;
          const members = group.slice(left, right);
          const bySession = new Map(members.map(e => [string(e.session.SessionID), e]));
          const iocMatched = members.some(e => e.iocMatched);
          clusters.push({ normalizedSnippet: snippet(group[left].text), kind: group[left].kind, sessionCount: counts.size,
            firstSeen: new Date(group[left].time).toISOString(), lastSeen: new Date(group[right - 1].time).toISOString(),
            operators: [...new Set(members.map(e => e.operator).filter(Boolean))], sessionIds: [...bySession.keys()].slice(0, 100), iocMatched });
          for (const [id, e] of bySession) if (!massSessions.has(id)) {
            massSessions.add(id);
            add(e.session, 'mass_execution', iocMatched ? 'high' : 'medium', e.text, { eventTime: new Date(e.time).toISOString(), operator: e.operator });
          }
        }
        const id = string(group[left].session.SessionID);
        const n = (counts.get(id) ?? 1) - 1;
        if (n) counts.set(id, n); else counts.delete(id);
      }
    }
    const rank = { high: 0, medium: 1, low: 2, info: 3 };
    findings.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.eventTime ?? '').localeCompare(b.eventTime ?? '') || a.sessionId.localeCompare(b.sessionId));
    const hits = findings.filter(f => f.severity !== 'info');
    const times = hits.flatMap(f => f.eventTime ? [f.eventTime] : []).sort();
    const skipped = result.length - scanned;
    const reasons = [result.length > maxSessions ? 'maxSessions' : '', signal.aborted || Date.now() >= deadline ? caller?.aborted ? 'caller aborted' : 'runtime budget' : '', errors ? 'details errors' : ''].filter(Boolean);
    return { summary: { since: new Date(since).toISOString(), until: new Date(until).toISOString(), sessionFilter: filter,
      totalMatched: result.length, sessionsTruncated: result.length > maxSessions, sessionsScanned: scanned, sessionsSkipped: skipped,
      partial: reasons.length > 0, ...(reasons.length ? { partialReason: reasons.join('; ') } : {}), errors, errorSamples,
      flaggedSessions: new Set(hits.map(f => f.sessionId)).size, findingsCount: findings.length,
      findingsTruncated: Math.max(0, findings.length - maxFindings), earliestHit: times[0] ?? null,
      highSeverityCount: findings.filter(f => f.severity === 'high').length,
      unknownOperatorCheck: known ? 'enabled' : 'skipped (no knownOperators)', iocSetVersion: IOC_SET_VERSION },
    massExecutionClusters: clusters, findings: findings.slice(0, maxFindings), nextSteps: NEXT_STEPS, coverageGaps: COVERAGE_GAPS };
  } finally {
    clearTimeout(timer);
  }
}
export const HUNT_TOOL: ToolDef = {
  tier: 'read', strictArgs: true,
  tool: { name: 'screenconnect_hunt_campaign',
    description: 'Read-only hunt for the Nov 11 2026 ScreenConnect campaign IOC set. Scans up to 500 sessions by default (max 5000), four detail reads at a time, with a 120s runtime budget; returns partial coverage and bounded findings.',
    inputSchema: { type: 'object', properties, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  handler: hunt,
};
