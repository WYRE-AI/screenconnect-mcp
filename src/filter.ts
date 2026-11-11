import { ArgumentError } from './types.js';
import { optionalBool, optionalEnum, optionalString } from './validate.js';
export const SESSION_TYPES = ['Support', 'Meeting', 'Access'] as const;
export function customProperties(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ArgumentError('customProperties must be a map of slots 1..8 to strings.');
  const result: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!/^[1-8]$/.test(key) || typeof v !== 'string' || v.length > 1000) throw new ArgumentError('Custom property slots must be 1..8, each at most 1000 characters.');
    result[key] = v;
  }
  return result;
}
export function buildFilter(args: Record<string, unknown>): string {
  const raw = optionalString(args, 'filter', { max: 4000 });
  const keys = ['sessionType', 'name', 'machineName', 'serialNumber', 'loggedOnUser', 'operatingSystem', 'customProperties', 'onlineOnly'];
  if (raw !== undefined && keys.some(k => args[k] !== undefined)) throw new ArgumentError('filter is mutually exclusive with structured search fields.');
  if (raw) return raw;
  const clauses: string[] = [];
  const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const type = optionalEnum(args, 'sessionType', SESSION_TYPES);
  if (type) clauses.push(`SessionType = ${quote(type)}`);
  for (const [key, field] of Object.entries({ name: 'Name', machineName: 'GuestMachineName', serialNumber: 'GuestMachineSerialNumber', loggedOnUser: 'GuestLoggedOnUserName', operatingSystem: 'GuestOperatingSystemName' })) {
    const v = optionalString(args, key, { max: 1000 });
    if (v) clauses.push(`${field} = ${quote(v)}`);
  }
  if (args.customProperties !== undefined) for (const [slot, v] of Object.entries(customProperties(args.customProperties))) clauses.push(`CustomProperty${slot} = ${quote(v)}`);
  if (optionalBool(args, 'onlineOnly')) clauses.push('GuestConnectedCount > 0');
  return clauses.join(' AND ');
}
