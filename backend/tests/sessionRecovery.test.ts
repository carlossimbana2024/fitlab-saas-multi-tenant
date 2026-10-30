import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { authCall, checkAuthAvailability } from '../src/utils/authAvailability.js';

const requireFrontend = createRequire(new URL('../../frontend/package.json', import.meta.url));
const axios = requireFrontend('axios/dist/node/axios.cjs');
const { QueryClient } = requireFrontend('@tanstack/react-query');
const source = readFileSync(new URL('../../frontend/src/services/sessionRecovery.ts', import.meta.url), 'utf8');
const exports: any = {};
new Function('exports', 'require', ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
} }).outputText)(exports, (name: string) => name === 'axios' ? axios : requireFrontend(name));
const { installSessionRecovery } = exports;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
function setup(options: { valid?: boolean; refreshStatus?: number; network?: boolean; refreshGate?: ReturnType<typeof deferred>; lateGate?: ReturnType<typeof deferred>; stillInvalid?: boolean } = {}) {
  let cookie = options.valid ? 'fresh' : 'expired';
  const calls: Array<{ url: string; cookie: string }> = [];
  const client = axios.create({ withCredentials: true, adapter: async (config: any) => {
    const sent = cookie;
    calls.push({ url: config.url, cookie: sent });
    const fail = (status: number, code: string) => { throw new axios.AxiosError('Rejected', 'ERR_BAD_RESPONSE', config, null, { status, data: { error: { code } }, config }); };
    if (config.url === '/auth/refresh') {
      await options.refreshGate?.promise;
      if (options.refreshStatus) fail(options.refreshStatus, options.refreshStatus === 401 ? 'INVALID_REFRESH_TOKEN' : 'AUTH_SERVICE_UNAVAILABLE');
      cookie = 'fresh';
    } else if (config.url.startsWith('/auth/') && config.url !== '/auth/me') {
      fail(401, 'INVALID_CREDENTIALS');
    } else {
      if (options.network) throw new axios.AxiosError('Network Error', 'ERR_NETWORK', config);
      if (config.url === '/late' && sent === 'expired') await options.lateGate?.promise;
      if (sent === 'expired' || options.stillInvalid) fail(401, 'INVALID_SESSION');
    }
    return { data: { user: { id: 'member' } }, status: 200, statusText: 'OK', headers: {}, config };
  } });
  const recovery = installSessionRecovery(client);
  return { client, recovery, calls, refreshes: () => calls.filter(call => call.url === '/auth/refresh') };
}

describe('FIT-MEMBER-006: actual Axios recovery interceptors', () => {
  it('A: valid access does not refresh', async () => {
    const s = setup({ valid: true }); await s.client.get('/auth/me'); expect(s.refreshes()).toHaveLength(0);
  });
  it('B: expired access recovers /auth/me exactly once using cookies', async () => {
    const s = setup(); expect((await s.client.get('/auth/me')).data.user.id).toBe('member');
    expect(s.calls.map(c => c.cookie)).toEqual(['expired', 'expired', 'fresh']);
    expect(s.refreshes()).toHaveLength(1);
  });
  it('C/D: invalid refresh expires once, clears private QueryClient data and never recurses', async () => {
    const s = setup({ refreshStatus: 401 }); const cache = new QueryClient(); cache.setQueryData(['member'], { private: true });
    let session: any = { user: 'member' };
    const clear = vi.fn(() => { session = null; void cache.cancelQueries(); cache.clear(); }); s.recovery.subscribe(clear);
    await expect(s.client.get('/auth/me')).rejects.toMatchObject({ response: { status: 401 } });
    expect(session).toBeNull(); expect(cache.getQueryCache().getAll()).toHaveLength(0);
    expect(clear).toHaveBeenCalledTimes(1); expect(s.refreshes()).toHaveLength(1);
  });
  it('E/F: concurrent requests wait for one refresh and all retry with fresh credentials', async () => {
    const gate = deferred(); const s = setup({ refreshGate: gate });
    const pending = ['/auth/me', '/activities', '/memberships', '/progress'].map(url => s.client.get(url));
    await vi.waitFor(() => expect(s.refreshes()).toHaveLength(1)); gate.resolve(); await Promise.all(pending);
    expect(s.refreshes()).toHaveLength(1);
    expect(s.calls.filter(c => c.cookie === 'fresh')).toHaveLength(4);
  });
  it('late 401 from the old cookie reuses successful refresh instead of rotating again', async () => {
    const gate = deferred(); const s = setup({ lateGate: gate }); const late = s.client.get('/late');
    await s.client.get('/auth/me'); gate.resolve(); await late; expect(s.refreshes()).toHaveLength(1);
  });
  it.each([500, 502, 503])('G: refresh %i preserves session and cache', async refreshStatus => {
    const s = setup({ refreshStatus }); const clear = vi.fn(); s.recovery.subscribe(clear);
    await expect(s.client.get('/auth/me')).rejects.toMatchObject({ response: { status: refreshStatus } }); expect(clear).not.toHaveBeenCalled();
  });
  it('H: /auth/me network failure never expires or refreshes', async () => {
    const s = setup({ network: true }); const clear = vi.fn(); s.recovery.subscribe(clear);
    await expect(s.client.get('/auth/me')).rejects.toMatchObject({ code: 'ERR_NETWORK' }); expect(clear).not.toHaveBeenCalled(); expect(s.refreshes()).toHaveLength(0);
  });
  it.each(['/auth/login', '/auth/register-owner', '/auth/forgot-password', '/auth/reset-password'])('%s cannot trigger refresh', async url => {
    const s = setup(); await expect(s.client.post(url)).rejects.toBeDefined(); expect(s.refreshes()).toHaveLength(0);
  });
  it('one retry maximum even if newly issued access is rejected', async () => {
    const s = setup({ stillInvalid: true }); const clear = vi.fn(); s.recovery.subscribe(clear);
    await expect(s.client.get('/auth/me')).rejects.toBeDefined(); expect(s.refreshes()).toHaveLength(1); expect(clear).toHaveBeenCalledOnce();
  });
  it('logout boundary waits for refresh and cancels old session retries', async () => {
    const gate = deferred(); const s = setup({ refreshGate: gate });
    const request = s.client.get('/auth/me').catch((error: any) => error);
    await vi.waitFor(() => expect(s.refreshes()).toHaveLength(1));
    const boundary = s.recovery.boundary(); gate.resolve(); await boundary;
    expect(axios.isCancel(await request)).toBe(true);
    expect(s.calls.filter(c => c.url === '/auth/me')).toHaveLength(1);
  });
});

describe('Auth upstream availability', () => {
  it.each([undefined, 0, 429, 500, 502, 503])('temporary status %s becomes 503, not 401', status => {
    expect(() => checkAuthAvailability({ status })).toThrow(expect.objectContaining({ statusCode: 503, code: 'AUTH_SERVICE_UNAVAILABLE' }));
  });
  it.each([400, 401, 403])('credential rejection %i remains distinguishable', status => { expect(() => checkAuthAvailability({ status })).not.toThrow(); });
  it('thrown transport failures are also temporary', async () => {
    await expect(authCall(async () => { throw new TypeError('fetch failed'); })).rejects.toMatchObject({ statusCode: 503 });
  });
});
