#!/usr/bin/env node
// No sockets or upstream calls: exercise the actual built MCP stdio transport.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const client = new Client({ name: 'smoke', version: '0.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'], env: { PATH: process.env.PATH ?? '', LOG_LEVEL: 'error', AUTH_MODE: 'env', SCREENCONNECT_BASE_URL: 'https://sc-eval.screenconnect.com', SCREENCONNECT_API_SECRET: 'eval-secret-not-real-0000', SCREENCONNECT_TOOL_TIERS: 'read' } });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 6);
  assert(tools.every(t => t.annotations?.readOnlyHint));
  const invalid = await client.callTool({ name: 'screenconnect_session_get', arguments: { sessionId: 'invalid' } });
  assert.equal(invalid.isError, true);
  const admin = await client.callTool({ name: 'screenconnect_session_send_command', arguments: { confirm: true } });
  assert.equal(admin.isError, true);
  console.log('smoke-stdio: OK (6 read tools; GUID rejection; admin hidden; no network)');
} finally { await client.close(); }
