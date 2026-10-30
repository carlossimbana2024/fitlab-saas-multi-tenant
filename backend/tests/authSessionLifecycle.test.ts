import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const requireFrontend = createRequire(new URL('../../frontend/package.json', import.meta.url));
const React = requireFrontend('react');
const { act, create } = requireFrontend('react-test-renderer');
const { QueryClient, QueryClientProvider } = requireFrontend('@tanstack/react-query');
const { MemoryRouter, Routes, Route, useLocation } = requireFrontend('react-router-dom');
const axios = requireFrontend('axios/dist/node/axios.cjs');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
function compile(file: string, dependencies: Record<string, any> = {}) {
  const source = readFileSync(new URL('../../frontend/src/' + file, import.meta.url), 'utf8');
  const output: any = {};
  new Function('exports', 'require', 'React', ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText)(output, (id: string) => dependencies[id] ?? requireFrontend(id), React);
  return output;
}
const recoveryModule = compile('services/sessionRecovery.ts', { axios });
const trees: any[] = [];
afterEach(async () => { await act(async () => { trees.splice(0).forEach(tree => tree.unmount()); }); vi.unstubAllGlobals(); });

async function mount(options: { expired?: boolean; invalidRefresh?: boolean; transient?: boolean; route?: string; delayed?: boolean } = {}) {
  let fresh = !options.expired;
  let temporary = !!options.transient;
  let release!: () => void;
  const gate = options.delayed ? new Promise<void>(r => { release = r; }) : Promise.resolve();
  const calls: string[] = [];
  const api = axios.create({ withCredentials: true, adapter: async (config: any) => {
    calls.push(config.url);
    const fail = (status: number, code: string) => { throw new axios.AxiosError('failure', undefined, config, null, { status, data: { error: { code } } }); };
    if (config.url === '/auth/refresh') {
      await gate;
      if (options.invalidRefresh) fail(401, 'INVALID_REFRESH_TOKEN');
      fresh = true;
    }
    if (config.url === '/auth/me') {
      if (temporary) fail(503, 'AUTH_SERVICE_UNAVAILABLE');
      if (!fresh) fail(401, 'INVALID_SESSION');
    }
    if (config.url === '/auth/logout') fresh = false;
    if (config.url === '/auth/login') fresh = true;
    const data = config.url === '/attendances/qr/preview'
      ? { gym_name: 'Gym', location_name: 'Branch', timezone: 'America/Guayaquil', server_time: '2026-10-30T12:00:00Z', attendance: null, membership: null }
      : { user: { id: 'member' }, gymUser: { id: 'member', gym_id: 'gym', role: 'member', status: 'active' } };
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  } });
  const sessionRecovery = recoveryModule.installSessionRecovery(api);
  const auth = compile('context/AuthContext.tsx', {
    axios, '../services/api': { api, sessionRecovery }, '../services/sessionRecovery': recoveryModule,
  });
  const { ProtectedRoute } = compile('components/ProtectedRoute.tsx', { '../context/AuthContext': auth });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  const { CheckInPage } = compile('pages/CheckInPage.tsx', {
    '../context/AuthContext': auth, '../services/api': { api, apiErrorMessage: () => 'error' },
    '../components/ThemeToggle': { ThemeToggle: () => null },
    '../components/AttendanceQrScanner': { AttendanceQrScanner: () => null },
    '../utils/attendanceQr': compile('utils/attendanceQr.ts'), '../styles/attendanceQr.css': {},
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(['private-member'], { secret: 'private' });
  let value: any; let location: any; let loginRenders = 0;
  function Probe() { value = auth.useAuth(); location = useLocation(); return null; }
  function Login() { loginRenders++; return React.createElement('p', null, 'LOGIN'); }
  let tree: any;
  await act(async () => {
    tree = create(React.createElement(React.StrictMode, null,
      React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(MemoryRouter, { initialEntries: [options.route ?? '/portal'] },
          React.createElement(auth.AuthProvider, null,
            React.createElement(Probe), React.createElement(Routes, null,
              React.createElement(Route, { element: React.createElement(ProtectedRoute) },
                React.createElement(Route, { path: '/portal', element: React.createElement('p', null, 'PORTAL') })),
              React.createElement(Route, { path: '/check-in', element: React.createElement(CheckInPage) }),
              React.createElement(Route, { path: '/login', element: React.createElement(Login) })) )))));
  });
  trees.push(tree);
  return { tree, queryClient, calls, get value() { return value; }, get location() { return location; }, get loginRenders() { return loginRenders; },
    async recoverNetwork() { temporary = false; await act(async () => { tree.root.findByType('button').props.onClick(); }); },
    async release() { await act(async () => { release(); await gate; }); },
    async failNetwork() { temporary = true; await act(async () => { await value.refresh(); }); },
  };
}

describe('Real React AuthProvider + router lifecycle', () => {
  it('A: active session renders protected portal; StrictMode does not duplicate bootstrap', async () => {
    const s = await mount(); expect(s.value.session.user.id).toBe('member'); expect(s.location.pathname).toBe('/portal');
    expect(s.calls).toEqual(['/auth/me']); expect(s.loginRenders).toBe(0);
  });
  it('B/I: direct protected route stays loading until refresh and never flashes login', async () => {
    const s = await mount({ expired: true, delayed: true }); expect(s.value.loading).toBe(true); expect(s.loginRenders).toBe(0);
    await s.release(); expect(s.value.session.user.id).toBe('member'); expect(s.value.loading).toBe(false);
    expect(s.location.pathname).toBe('/portal'); expect(s.loginRenders).toBe(0);
  });
  it('C: invalid refresh clears actual provider/cache and redirects to login', async () => {
    const s = await mount({ expired: true, invalidRefresh: true });
    expect(s.value.session).toBeNull(); expect(s.location.pathname).toBe('/login');
    expect(s.queryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(s.calls.filter(c => c === '/auth/refresh')).toHaveLength(1);
  });
  it('G/H: initial outage shows retry instead of login and keeps the requested URL', async () => {
    const s = await mount({ transient: true }); expect(JSON.stringify(s.tree.toJSON())).toContain('No pudimos comprobar');
    expect(s.loginRenders).toBe(0); expect(s.queryClient.getQueryData(['private-member'])).toBeDefined();
    await s.recoverNetwork(); expect(s.location.pathname).toBe('/portal'); expect(s.value.session).not.toBeNull();
  });
  it('existing authenticated user/cache survive temporary revalidation failure', async () => {
    const s = await mount(); await s.failNetwork(); expect(s.value.session.user.id).toBe('member');
    expect(s.queryClient.getQueryData(['private-member'])).toBeDefined(); expect(s.loginRenders).toBe(0);
  });
  it('I: external QR hash survives refresh; confirmation opens without recording attendance', async () => {
    const hash = '#token=' + 'a'.repeat(43);
    const s = await mount({ expired: true, route: '/check-in' + hash });
    expect(s.location.pathname + s.location.hash).toBe('/check-in' + hash); expect(s.loginRenders).toBe(0);
    expect(JSON.stringify(s.tree.toJSON())).toContain('Confirma tu llegada');
    expect(s.calls).not.toContain('/attendances/qr/check-in');
  });
  it('logout clears state/cache and normal login restores session', async () => {
    const s = await mount(); await act(async () => { await s.value.logout(); });
    expect(s.value.session).toBeNull(); expect(s.queryClient.getQueryCache().getAll()).toHaveLength(0);
    await act(async () => { await s.value.login('member@example.test', 'password123'); });
    expect(s.value.session.user.id).toBe('member'); expect(s.calls).toContain('/auth/logout'); expect(s.calls).toContain('/auth/login');
  });
});
