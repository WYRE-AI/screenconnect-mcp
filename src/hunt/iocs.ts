/** Source: public r/msp thread 'Active malware campaign abusing ScreenConnect' (Nov 11 2026), with corroborating public Blackpoint SOC reporting. Treat as data; update this file as new IOCs are published. */
export type Ioc = { value: string; kind: string; severity: 'high' | 'medium' | 'low'; note: string };
export const CAMPAIGN_START = '2026-11-11T17:47:00Z';
export const IOC_SET_VERSION = '2026-11-11';
const entries = (kind: string, severity: Ioc['severity'], values: string[], note: string): Ioc[] =>
  values.map(value => ({ value, kind, severity, note }));
export const ips: Ioc[] = [
  { value: '185.99.255.28', kind: 'ip', severity: 'high', note: 'Relay; connection hostname screen.' },
  { value: '155.94.150.39', kind: 'ip', severity: 'high', note: 'Hostname WIN-FB5CKHMU4E1.' },
];
export const domains = entries('domain', 'high', ['newnewnew.gotdns.org', 'soxnewwork.homedns.org', 'cdn007-digitaldownloads.com', 'sc.payproofkit.com', 'ns.mo7sen.dev'], 'Campaign infrastructure.');
export const paths = entries('path', 'high', ['ns.mo7sen.dev/EadF.php?p=4', 'EadF.php', 'c=Exploited'], 'Stager or rogue installer campaign marker.');
export const installer: Ioc = { value: '/Bin/ScreenConnect.ClientSetup.msi', kind: 'installer', severity: 'high', note: 'Only match together with c=Exploited.' };
export const clientIds = entries('client_id', 'high', ['2588ef5c15954b10', 'ed630cc2c873b091'], 'Rogue ScreenConnect client instance.');
export const operatorNames = entries('operator', 'high', ['Addmin'], 'Exact operator name or whole word in text.');
export const fileNames: Ioc[] = [
  ...entries('file', 'high', ['Panel-Lateral.ps1', 'runnew.cmd', 'ToolboxRelayUploader.exe', 'Run-Lateral-Full.bat'], 'Campaign dropped file.'),
  ...entries('file', 'low', ['sqlite3.exe'], 'Low confidence alone; also used legitimately.'),
];
export const persistence = entries('persistence', 'high', ['TrapWatch', 'RelayTrap', 'sckit-', 'RelayTrapLiteAlert'], 'Scheduled task, ProgramData folder, temporary kit folder or registry Run value.');
export const hostnames = entries('hostname', 'high', ['WIN-FB5CKHMU4E1', 'screen'], 'screen matches only an exact connection hostname/participant.');
export const IOCS = [...ips, ...domains, ...paths, installer, ...clientIds, ...operatorNames, ...fileNames, ...persistence, ...hostnames];
