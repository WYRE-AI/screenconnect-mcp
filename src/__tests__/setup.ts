import { afterEach, beforeEach, vi } from 'vitest';
import { setTransport, setResolver } from '../egress.js';
import { resetGatewayLock } from '../config.js';
import { resetToolsets } from '../tools/index.js';
beforeEach(() => {
  vi.stubEnv('AUTH_MODE', 'env');
  vi.stubEnv('SCREENCONNECT_BASE_URL', 'https://sc-eval.screenconnect.com');
  vi.stubEnv('SCREENCONNECT_API_SECRET', 'eval-secret-not-real-0000');
  vi.stubEnv('SCREENCONNECT_TOOL_TIERS', 'read');
  setTransport(async () => { throw new Error('Unmocked outbound request'); });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); setTransport(undefined); setResolver(undefined); resetGatewayLock(); resetToolsets(); });
