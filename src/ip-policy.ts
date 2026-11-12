import { BlockList, isIP } from 'node:net';

/**
 * Destinations the sidecar must never connect to unless private hosts are
 * explicitly allowed (local/on-prem env mode only): loopback, RFC 1918,
 * CGNAT, link-local (incl. cloud metadata 169.254.169.254 and fd00:ec2::254),
 * unique-local, multicast, documentation, benchmarking, and reserved space.
 */
const BLOCKED = new BlockList();

const V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const V6: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

for (const [net, bits] of V4) BLOCKED.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of V6) BLOCKED.addSubnet(net, bits, 'ipv6');

function expandV6(ip: string): number[] | null {
  let v = ip.toLowerCase().replace(/%.*$/, '');
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (dotted) {
    const o = dotted[1].split('.').map(Number);
    v = v.slice(0, -dotted[1].length) + `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail] = v.includes('::') ? v.split('::') : [v, undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  if (fill < 0) return null;
  const groups = [...h, ...Array(fill).fill('0'), ...t].map((g) => Number.parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

function v4FromGroups(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** IPv4 addresses embedded in IPv6 transition formats, which route to the embedded v4 host. */
function embeddedV4(ip: string): string[] {
  const g = expandV6(ip);
  if (!g) return [];
  const out: string[] = [];
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-translated ::ffff:0:a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) out.push(v4FromGroups(g[6], g[7]));
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) out.push(v4FromGroups(g[6], g[7]));
  // NAT64 64:ff9b::/96 and local-use 64:ff9b:1::/48
  if (g[0] === 0x64 && g[1] === 0xff9b) out.push(v4FromGroups(g[6], g[7]));
  // 6to4 2002:AABB:CCDD::/16
  if (g[0] === 0x2002) out.push(v4FromGroups(g[1], g[2]));
  // Teredo 2001:0::/32 (client v4 is bit-inverted in the last 32 bits)
  if (g[0] === 0x2001 && g[1] === 0) out.push(v4FromGroups(g[6] ^ 0xffff, g[7] ^ 0xffff));
  return out;
}

/** True for any IP literal the sidecar must not connect to. Non-IP input returns false. */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return BLOCKED.check(ip, 'ipv4');
  if (kind === 6) {
    if (BLOCKED.check(ip, 'ipv6')) return true;
    const g = expandV6(ip);
    if (!g) return true;
    return embeddedV4(ip).some((v4) => BLOCKED.check(v4, 'ipv4'));
  }
  return false;
}
