import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// A stateful Auth double: administrative password updates revoke every session,
// whereas PUT /auth/v1/user preserves the session identified by its bearer token.
const provider = vi.hoisted(() => ({ active: true, passwordChanged: false, wrongPassword: false,
  profile: { full_name: 'Nombre inicial', phone: '0990000000' }, verify: vi.fn(), adminUpdate: vi.fn(), fetch: vi.fn() }));
vi.mock('../src/config/env.js', () => ({ env: { NODE_ENV: 'production', frontendOrigins: ['https://fitlab.test'],
  SUPABASE_URL: 'https://auth.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture-public' } }));
vi.mock('../src/config/stripe.js', () => ({ stripe: {} }));
vi.mock('../src/services/memberProfile.service.js', () => ({ signAvatarUrl: vi.fn() }));
vi.mock('../src/config/supabase.js', () => ({ supabasePublic: { auth: { signInWithPassword: provider.verify,
  getUser: async () => provider.active ? { data: { user: { id: 'member', email: 'member@example.test' } }, error: null }
    : { data: { user: null }, error: { status: 401 } } } },
  supabaseAdmin: { auth: { admin: { updateUserById: provider.adminUpdate } } }, createUserSupabaseClient: () => ({}) }));
import { changePassword } from '../src/controllers/auth.controller.js';
import { verifyJWT } from '../src/middlewares/verifyJWT.js';

const req = createRequire(new URL('../../frontend/package.json', import.meta.url));
const React = req('react'); const { act, create } = req('react-test-renderer');
const { QueryClient, QueryClientProvider, useQuery } = req('@tanstack/react-query');
const { MemoryRouter, Routes, Route, useLocation } = req('react-router-dom');
const axios = req('axios/dist/node/axios.cjs');
function compile(file: string, deps: Record<string, any> = {}) {
  const output: any = {};
  const source = readFileSync(new URL('../../frontend/src/' + file, import.meta.url), 'utf8');
  new Function('exports', 'require', 'React', ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText)(output, (id: string) => deps[id] ?? req(id), React);
  return output;
}
const recoveryModule = compile('services/sessionRecovery.ts', { axios });
const { refreshMemberQueries } = compile('utils/memberQueryInvalidation.ts');
const trees: any[] = []; const clients: any[] = [];
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => {
  vi.resetAllMocks(); provider.active = true; provider.passwordChanged = false; provider.wrongPassword = false;
  provider.profile = { full_name: 'Nombre inicial', phone: '0990000000' };
  provider.verify.mockImplementation(async () => ({ data: {}, error: provider.wrongPassword ? { status: 400 } : null }));
  provider.adminUpdate.mockImplementation(async () => { provider.passwordChanged = true; provider.active = false; return { data: {}, error: null }; });
  provider.fetch.mockImplementation(async () => { provider.passwordChanged = true; return new Response(JSON.stringify({ id: 'member' }), { status: 200 }); });
  vi.stubGlobal('fetch', provider.fetch);
});
afterEach(async () => { await act(async () => trees.splice(0).forEach(tree => tree.unmount())); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });
async function mount(options: { readFailure?: boolean } = {}) {
  const calls: string[] = []; let sessionReadFailed = false;
  const api = axios.create({ adapter: async (config: any) => {
    calls.push(config.url);
    const fail = (status: number, code: string) => { throw new axios.AxiosError('request failed', undefined, config, null, { status, data: { error: { code } } }); };
    if (config.url === '/auth/refresh') fail(401, 'INVALID_REFRESH_TOKEN');
    const request: any = { authUser: { id: 'member', email: 'member@example.test' }, accessToken: 'fixture-access',
      signedCookies: { fitlab_access_token: 'fixture-access' }, headers: {}, body: config.data ? JSON.parse(config.data) : {} };
    const authenticationError = await new Promise<any>(resolve => { verifyJWT(request, {} as any, resolve); });
    if (authenticationError) fail(authenticationError.statusCode, authenticationError.code);
    let data: any = {};
    if (config.url === '/members/me/profile') provider.profile = { full_name: request.body.fullName, phone: request.body.phone };
    if (config.url === '/auth/change-password') {
      try { await changePassword(request, { json: (result: any) => { data = result; } } as any); }
      catch (error: any) { fail(error.statusCode, error.code); }
    }
    if (config.url === '/auth/me') {
      if (options.readFailure && provider.passwordChanged) { sessionReadFailed = true; fail(503, 'AUTH_SERVICE_UNAVAILABLE'); }
      data = { user: { id: 'member' }, gymUser: { id: 'gym-member', gym_id: 'gym', role: 'member', status: 'active', profiles: { ...provider.profile } } };
    }
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  } });
  const sessionRecovery = recoveryModule.installSessionRecovery(api);
  const auth = compile('context/AuthContext.tsx', { axios, '../services/api': { api, sessionRecovery }, '../services/sessionRecovery': recoveryModule });
  const { ProtectedRoute } = compile('components/ProtectedRoute.tsx', { '../context/AuthContext': auth });
  const { MemberAccountDialog } = compile('components/MemberAccountDialog.tsx', { '../services/api': { api },
    './ProfileDialog': { ProfileDialog: ({ children }: any) => React.createElement('section', null, children) } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }); clients.push(client);
  client.setQueryData(['unrelated-private'], { preserved: true });
  let value: any; let location: any;
  function Probe() { value = auth.useAuth(); location = useLocation(); return null; }
  function Account() {
    const { session, refresh, applyConfirmedProfile } = auth.useAuth();
    useQuery({ queryKey: ['member-social-profile', 'me'], queryFn: () => api.get('/members/me/social-profile') });
    return React.createElement(MemberAccountDialog, {
      initialProfile: { fullName: session.gymUser.profiles.full_name, phone: session.gymUser.profiles.phone }, onClose() {},
      onProfileSaved: (profile: any) => applyConfirmedProfile(session.user.id, profile),
      onIdentitySaved: () => Promise.all([refresh({ background: true }), refreshMemberQueries(client, { gymId: 'gym', memberId: 'gym-member' }, 'identity')]),
    });
  }
  let tree: any;
  await act(async () => { tree = create(React.createElement(QueryClientProvider, { client }, React.createElement(MemoryRouter, { initialEntries: ['/portal'] },
    React.createElement(auth.AuthProvider, null, React.createElement(Probe), React.createElement(Routes, null,
      React.createElement(Route, { element: React.createElement(ProtectedRoute) }, React.createElement(Route, { path: '/portal', element: React.createElement(Account) })),
      React.createElement(Route, { path: '/login', element: React.createElement('p', null, 'LOGIN') })))))); });
  trees.push(tree);
  const inputs = () => tree.root.findAllByType('input');
  return { tree, api, calls, client, get value() { return value; }, get location() { return location; }, get sessionReadFailed() { return sessionReadFailed; },
    async submit(profile: boolean, password: boolean) {
      const entries = [...(profile ? [[0, 'Nombre confirmado'], [1, '0990000001']] : []), ...(password ? [[2, 'fixture-current'], [3, 'fixture-next'], [4, 'fixture-next']] : [])];
      for (const [index, text] of entries) await act(async () => { inputs()[Number(index)].props.onChange({ target: { value: text } }); });
      await act(async () => { await tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
    },
  };
}
const text = (s: any) => JSON.stringify(s.tree.toJSON());
describe('FIT-MEMBER-017 real dialog + AuthProvider + recovery + password controller', () => {
  it('A: password-only preserves a server-valid session, not just the cached portal', async () => {
    const s = await mount(); await s.submit(false, true);
    expect(provider.passwordChanged).toBe(true); expect(text(s)).toContain('Contraseña actualizada.');
    await act(async () => { await s.api.get('/protected'); });
    expect(s.value.session?.user.id).toBe('member'); expect(s.location.pathname).toBe('/portal');
  });
  it('B: profile-only saves both fields and preserves the session', async () => {
    const s = await mount(); await s.submit(true, false);
    expect(s.value.session.gymUser.profiles).toEqual(provider.profile); expect(provider.profile.full_name).toBe('Nombre confirmado');
    expect(s.location.pathname).toBe('/portal'); expect(provider.passwordChanged).toBe(false);
  });
  it('C: manual regression, combined profile + password and following refetch preserve session', async () => {
    const s = await mount(); await s.submit(true, true);
    expect(provider.passwordChanged).toBe(true); expect(provider.profile.full_name).toBe('Nombre confirmado');
    expect(s.value.session?.user.id).toBe('member'); expect(s.location.pathname).toBe('/portal');
    expect(text(s)).toContain('Datos de cuenta guardados.'); expect(text(s)).toContain('Contraseña actualizada.');
    expect(s.tree.root.findAllByType('input').filter((n: any) => n.props.type === 'password').every((n: any) => n.props.value === '')).toBe(true);
    expect(s.calls).not.toContain('/auth/refresh'); expect(s.calls).not.toContain('/auth/logout');
    expect(s.client.getQueryData(['unrelated-private'])).toEqual({ preserved: true });
  });
  it('D: profile success plus rejected password keeps confirmed fields and session', async () => {
    const s = await mount(); provider.wrongPassword = true; await s.submit(true, true);
    expect(s.value.session.gymUser.profiles).toEqual(provider.profile); expect(s.location.pathname).toBe('/portal');
    expect(text(s)).toContain('La contraseña actual no es correcta.'); expect(provider.passwordChanged).toBe(false);
  });
  it('E: password success plus failed profile reread shows warning, never false logout', async () => {
    const s = await mount({ readFailure: true }); await s.submit(true, true);
    expect(s.sessionReadFailed).toBe(true); expect(s.value.session?.user.id).toBe('member'); expect(s.location.pathname).toBe('/portal');
    expect(text(s)).toContain('Contraseña actualizada.'); expect(text(s)).toContain('no pudimos actualizar todas las vistas');
    expect(s.value.session.gymUser.profiles.full_name).toBe('Nombre confirmado');
  });
  it('F: truly invalid Auth still expires the session and redirects to login', async () => {
    const s = await mount(); provider.active = false;
    await act(async () => { await s.api.get('/protected').catch(() => undefined); });
    expect(s.value.session).toBeNull(); expect(s.location.pathname).toBe('/login');
    expect(s.client.getQueryCache().getAll()).toHaveLength(0);
  });
});
