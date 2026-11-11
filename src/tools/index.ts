import { ALL_TIERS, parseToolTiers, type ToolTier } from '../config.js';
import { SESSION_TOOLS } from './sessions.js';
import { buildToolset as build, type Toolset } from './shared.js';
export type { Toolset } from './shared.js';
export const ALL_TOOL_DEFS = SESSION_TOOLS;
export function buildToolset(tiers: ReadonlySet<ToolTier>): Toolset { return build(tiers, ALL_TOOL_DEFS); }
let defaultToolset: Toolset | undefined;
const cache = new Map<string, Toolset>();
export function getDefaultToolset(): Toolset { return defaultToolset ??= buildToolset(parseToolTiers(process.env.SCREENCONNECT_TOOL_TIERS)); }
export function toolsetForTiers(requested: ReadonlySet<ToolTier>): Toolset {
  const base = getDefaultToolset();
  const tiers = ALL_TIERS.filter(t => base.tiers.has(t) && requested.has(t));
  const key = tiers.join(',');
  let set = cache.get(key);
  if (!set) { set = buildToolset(new Set(tiers)); cache.set(key, set); }
  return set;
}
export function resetToolsets(): void { defaultToolset = undefined; cache.clear(); }
