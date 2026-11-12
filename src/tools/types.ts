import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolTier } from '../config.js';
import type { ScreenConnectCredentials } from '../types.js';

export type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type ToolArgs = Record<string, unknown>;

export interface ToolDef {
  tier: ToolTier;
  /** Opt-in rejection of undeclared arguments without changing legacy tool behavior. */
  strictArgs?: boolean;
  tool: Tool;
  /** Receives only the arguments declared in `tool.inputSchema.properties`. Returns a JSON-serializable value; output is redacted and truncated by the dispatcher. */
  handler: (args: ToolArgs, creds: ScreenConnectCredentials) => Promise<unknown>;
}
