import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { getDefaultToolset } from './tools/index.js';
import { logger } from './utils/logger.js';

const toolset = getDefaultToolset();
const server = createServer(toolset);
await server.connect(new StdioServerTransport());
logger.info('ScreenConnect MCP server started (stdio)', { tiers: [...toolset.tiers], tools: toolset.tools.length });
