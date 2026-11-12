import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { credentialSecrets, resolveCredentials } from '../client.js';
import { maxResponseChars, type ToolTier } from '../config.js';
import { runWithAbortSignal } from '../egress.js';
import { renderSafe } from '../redact.js';
import { ArgumentError, ScreenConnectApiError, UnsafeBaseUrlError } from '../types.js';
import { requireConfirm } from '../validate.js';
import { logger } from '../utils/logger.js';
import type { ToolArgs, ToolDef, CallToolResult } from './types.js';
import { MissingCredentialsError } from '../client.js';
export interface Toolset {
  tiers: ReadonlySet<ToolTier>;
  tools: Tool[];
  dispatch: (name: string, args: unknown, signal?: AbortSignal) => Promise<CallToolResult>;
}
export function pickDeclaredArgs(tool: Tool, args: unknown): ToolArgs {
  const source = args && typeof args === 'object' && !Array.isArray(args) ? args as ToolArgs : {};
  return Object.fromEntries(Object.keys(tool.inputSchema.properties ?? {}).filter(k => Object.hasOwn(source, k)).map(k => [k, source[k]]));
}
export function buildToolset(tiers: ReadonlySet<ToolTier>, defs: readonly ToolDef[]): Toolset {
  const enabled = defs.filter(d => tiers.has(d.tier));
  return { tiers, tools: enabled.map(d => d.tool), dispatch: async (name, rawArgs, signal) => {
    try {
      const def = enabled.find(d => d.tool.name === name);
      if (!def) throw new ArgumentError('Unknown or disabled tool.');
      if (def.strictArgs && (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs) || Object.keys(rawArgs).some(k => !Object.hasOwn(def.tool.inputSchema.properties ?? {}, k)))) throw new ArgumentError('Expected an object with only declared arguments.');
      const args = pickDeclaredArgs(def.tool, rawArgs);
      if (def.tier === 'admin') requireConfirm(args);
      const value = await runWithAbortSignal(signal, () => def.handler(args, resolveCredentials()));
      logger.info('Tool call succeeded', { tool: name, tier: def.tier });
      return { content: [{ type: 'text', text: renderSafe(value, maxResponseChars(), credentialSecrets()) }] };
    } catch (err) {
      const message = err instanceof ArgumentError || err instanceof ScreenConnectApiError || err instanceof UnsafeBaseUrlError || err instanceof MissingCredentialsError ? err.message : 'ScreenConnect request failed or was cancelled.';
      logger.warn('Tool call failed', { tool: name, errorType: err instanceof Error ? err.constructor.name : 'unknown' });
      return { isError: true, content: [{ type: 'text', text: renderSafe(`Error: ${message}`, maxResponseChars(), credentialSecrets()) }] };
    }
  } };
}
