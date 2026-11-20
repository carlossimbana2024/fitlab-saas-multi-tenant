import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as currentPortalDate from '../../frontend/src/utils/currentPortalDate';
import * as portalTime from '../../frontend/src/utils/portalTime';

const req = createRequire(new URL('../../frontend/package.json', import.meta.url));
const axios = req('axios/dist/node/axios.cjs');
const React = req('react');
const { act, create } = req('react-test-renderer');
const { QueryClient, QueryClientProvider } = req('@tanstack/react-query');
const { MemoryRouter, Route, Routes, useNavigate } = req('react-router-dom');
const empty = new Proxy({}, { get: () => () => null });

function compile(file: string, deps: Record<string, any> = {}) {
  const source = readFileSync(new URL('../../frontend/src/' + file, import.meta.url), 'utf8');
  const exports = {};
  new Function('exports', 'require', 'React', ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true,
  } }).outputText)(exports, (id: string) => deps[id] ?? req(id), React);
  return exports as Record<string, any>;
}

const adminPin = compile('services/adminPinElevation.ts', { axios });
const queue = compile('services/adminPinQueue.ts', { './adminPinElevation': adminPin });
const recovery = compile('services/sessionRecovery.ts', { axios });
const finance = 'finances.view';
const payments = '/member-payments';
const summary = '/member-payments/dashboard-summary';
const pinUrl = '/permissions/elevate';
const initialIdentity = { user: { id: 'profile-a' }, gymUser: { id: 'staff-a', gym_id: 'gym-a', role: 'staff' }, onboardingRequired: false };
const goodPin = '4827'; // Synthetic fixture. Never uses a real account or network.
const disposals: Array<() => void> = [];

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
const label = (tree: any): string => JSON.stringify(tree.toJSON());
const tick = async (work: () => unknown = () => {}) => {
  await act(async () => { work(); await new Promise(resolve => setTimeout(resolve, 0)); });
};
const waitFor = (assert: () => void) => vi.waitFor(async () => { await tick(); assert(); });

function fakeApi() {
  let identity = structuredClone(initialIdentity);
  let mode: 'allowed' | 'denied' | 'requires_pin' = 'requires_pin';
  let pinFailure: { status: number; code: string } | undefined;
  let pinGate: ReturnType<typeof deferred> | undefined;
  let challengeGate: ReturnType<typeof deferred> | undefined;
  let expiredGrant = false;
  let afterPin: { status?: number; code: string } | undefined;
  let nextToken = 0;
  const tokens = new Map<string, { owner: string; permission: string }>();
  const attempts: string[] = [];
  const challenges: Array<{ url: string; permission: string; method: string }> = [];
  const authorized: Array<{ url: string; permission: string; method: string; token: string }> = [];
  const sent: string[] = [];
  const api = axios.create({ adapter: async (cfg: any) => {
    const url = cfg.url as string;
    const owner = identity.user.id;
    const ok = (data: unknown) => ({ config: cfg, status: 200, statusText: 'OK', headers: {}, data });
    const fail = (status: number, code: string, permission?: string) => {
      throw new axios.AxiosError(code, undefined, cfg, null, {
        status, data: { error: { code, message: code, details: { permission } } },
      });
    };
    sent.push(url);
    if (url === '/auth/me') return ok(identity);
    if (url === '/auth/logout') return ok(null);
    if (url === pinUrl) {
      const payload = JSON.parse(cfg.data);
      attempts.push(payload.permission);
      await pinGate?.promise;
      if (pinFailure) fail(pinFailure.status, pinFailure.code);
      if (payload.pin !== goodPin) fail(403, 'INVALID_ADMIN_PIN');
      const token = `token-${++nextToken}`;
      tokens.set(token, { owner, permission: payload.permission });
      return ok({ token, expiresAt: new Date(Date.now() + (expiredGrant ? -60000 : 300000)).toISOString() });
    }
    const permission = url === '/write/foreign' ? 'members.manage' : finance;
    if (url.startsWith(payments) || url.startsWith('/write/') || url.startsWith('/protected/')) {
      const token = cfg.headers.get('x-admin-elevation-token');
      if (identity.gymUser.role === 'owner' || mode === 'allowed') { /* no elevation */ }
      else if (mode === 'denied') fail(403, 'PERMISSION_DENIED');
      else if (!token) {
        challenges.push({ url, permission, method: cfg.method });
        await challengeGate?.promise;
        fail(403, 'REQUIRES_ADMIN_PIN', permission);
      } else {
        const grant = tokens.get(token);
        if (!grant || grant.owner !== owner || grant.permission !== permission) fail(403, 'INVALID_ADMIN_ELEVATION');
        tokens.delete(token);
        authorized.push({ url, permission, method: cfg.method, token });
        if (afterPin?.status) fail(afterPin.status, afterPin.code, permission);
        if (afterPin) throw new axios.AxiosError(afterPin.code, afterPin.code, cfg);
      }
      return url === payments ? ok({ payments: [] }) : url === summary
        ? ok({ summary: { month: currentPortalDate.portalDate().slice(0, 7), currencies: [] } }) : ok({ done: true });
    }
    if (url === '/members/dashboard-summary') return ok({ members: [], activeMemberCount: 1 });
    if (url === '/attendances') return ok({ attendances: [] });
    if (url.endsWith('dashboard-summary')) return ok({ validTodayCount: 0 });
    if (url.endsWith('/streaks')) return ok({ streaks: [] });
    return ok({ authorized: false });
  } });
  const sessionRecovery = recovery.installSessionRecovery(api);
  const registerAdminPinElevationHandler = adminPin.installAdminPinElevation(api, sessionRecovery);
  const deps = { api, sessionRecovery, registerAdminPinElevationHandler,
    apiErrorMessage: (cause: any) => cause.response?.data?.error?.message ?? cause.message };
  return {
    api, deps, sessionRecovery, attempts, challenges, authorized, sent,
    setMode(value: typeof mode) { mode = value; },
    setRole(value: string) { identity.gymUser.role = value; },
    setIdentity(value: typeof identity) { identity = value; },
    setPinFailure(value: typeof pinFailure) { pinFailure = value; },
    blockPin() { return pinGate = deferred(); },
    blockChallenges() { return challengeGate = deferred(); },
    expireGrant() { expiredGrant = true; },
    failAfterPin(value: typeof afterPin) { afterPin = value; },
  };
}

async function mount(s: ReturnType<typeof fakeApi>, withDashboard = false) {
  const { AdminPinDialog } = compile('components/AdminPinDialog.tsx', {
    axios, 'lucide-react': empty, '../services/api': s.deps, '../services/adminPinQueue': queue,
  });
  const auth = compile('context/AuthContext.tsx', {
    axios, '../services/api': s.deps, '../services/sessionRecovery': recovery,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retryDelay: 0, retry: (n: number, e: unknown) => n < 1 && !adminPin.isAdminPinFailure(e) } },
  });
  let tree: any;
  let go: (url: string) => void;
  let currentAuth: any;
  function Probe() { go = useNavigate(); currentAuth = auth.useAuth(); return null; }
  const { AppLayout } = compile('components/AppLayout.tsx', {
    'lucide-react': empty, '../context/AuthContext': auth, '../services/api': s.deps, './AdminPinDialog': { AdminPinDialog },
    './ThemeToggle': empty,
  });
  const { DashboardPage } = compile('pages/DashboardPage.tsx', {
    'lucide-react': empty, '../context/AuthContext': auth, '../services/api': s.deps,
    '../components/OwnerAnnouncementsPanel': empty, '../components/MembershipPaymentManagement': empty,
    '../utils/currentPortalDate': currentPortalDate, '../utils/portalTime': portalTime,
  });
  const h = React.createElement;
  const child = withDashboard ? h(Routes, null, h(Route, { element: h(AppLayout) },
    h(Route, { path: '/dashboard', element: h(DashboardPage) }), h(Route, { path: '/other', element: h('p', null, 'Otra página') }),
  )) : h(AdminPinDialog);
  function ProtectedFixture() { return auth.useAuth().session ? child : null; }
  await tick(() => {
    tree = create(h(React.StrictMode, null, h(QueryClientProvider, { client: queryClient },
      h(MemoryRouter, { initialEntries: ['/dashboard'] }, h(auth.AuthProvider, null, h(Probe), h(ProtectedFixture))))));
  });
  disposals.push(() => { tree.unmount(); queryClient.clear(); });
  await waitFor(() => expect(currentAuth.session?.user.id).toBeDefined());
  return { tree, queryClient, get auth() { return currentAuth; }, go: (url: string) => go(url) };
}

function pending(actions: Array<() => Promise<any>>) {
  return Promise.allSettled(actions.map(send => send())); // Attach handlers immediately.
}
const hasDialog = (tree: any) => tree.root.findAllByProps({ role: 'dialog' }).length > 0;
async function enter(tree: any, pin = goodPin, twice = false) {
  await tick(() => tree.root.findByType('input').props.onChange({ target: { value: pin } }));
  await tick(() => {
    const submit = tree.root.findByType('form').props.onSubmit;
    void submit({ preventDefault() {} });
    if (twice) void submit({ preventDefault() {} });
  });
}
async function cancel(tree: any) {
  await tick(() => tree.root.findAllByType('button').find((b: any) => b.props.children === 'Cancelar').props.onClick());
}
const promiseSettles = async (result: Promise<PromiseSettledResult<any>[]>, status: string, count: number) => {
  const settled = await result;
  expect(settled).toHaveLength(count);
  expect(settled.every(item => item.status === status)).toBe(true);
  return settled as PromiseRejectedResult[];
};

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(async () => { await tick(() => disposals.splice(0).forEach(dispose => dispose())); vi.unstubAllGlobals(); });

it('real Dashboard makes both financial GET requests and finishes both, one explicit approval per token', async () => {
  const s = fakeApi();
  const ui = await mount(s, true);
  await waitFor(() => expect(s.challenges.map(c => c.url).sort()).toEqual([payments, summary]));
  expect(hasDialog(ui.tree)).toBe(true);
  await enter(ui.tree);
  await waitFor(() => expect(s.authorized).toHaveLength(1));
  expect(hasDialog(ui.tree)).toBe(true);
  expect(ui.tree.root.findByType('input').props.value).toBe('');
  await enter(ui.tree);
  await waitFor(() => {
    expect(ui.queryClient.getQueryState(['payments'])?.status).toBe('success');
    expect(ui.queryClient.getQueryState(['dashboard-income-summary', 'gym-a', 'staff-a', currentPortalDate.portalDate().slice(0, 7), portalTime.DEFAULT_TIMEZONE])?.status).toBe('success');
    expect(label(ui.tree)).toContain('0.00 USD');
  });
  expect(new Set(s.authorized.map(a => a.token)).size).toBe(2);
  expect(s.attempts).toEqual([finance, finance]);
  expect(hasDialog(ui.tree)).toBe(false);
});

it('settles five simultaneous requests in FIFO order with five different single-use grants', async () => {
  const s = fakeApi();
  const { tree } = await mount(s);
  let results!: Promise<PromiseSettledResult<any>[]>;
  const paths = Array.from({ length: 5 }, (_, i) => `/protected/${i}`);
  await tick(() => { results = pending(paths.map(url => () => s.api.get(url))); });
  expect(s.challenges).toHaveLength(5);
  for (let i = 0; i < 5; i++) {
    expect(hasDialog(tree)).toBe(true);
    await enter(tree, goodPin, true);
  }
  await promiseSettles(results, 'fulfilled', 5);
  expect(s.authorized.map(a => a.url)).toEqual(paths);
  expect(new Set(s.authorized.map(a => a.token)).size).toBe(5);
  expect(s.attempts).toHaveLength(5);
  expect(hasDialog(tree)).toBe(false);
});

it('cancels all waiters even during submit, ignores a late grant and permits a new prompt later', async () => {
  const s = fakeApi(); const { tree } = await mount(s);
  const gate = s.blockPin();
  let results!: Promise<PromiseSettledResult<any>[]>;
  await tick(() => { results = pending([() => s.api.get(payments), () => s.api.get(summary)]); });
  await enter(tree);
  expect(label(tree)).toContain('Validando…');
  await cancel(tree);
  const rejected = await promiseSettles(results, 'rejected', 2);
  expect(rejected.every(r => axios.isCancel(r.reason) && adminPin.isAdminPinFailure(r.reason))).toBe(true);
  await tick(() => gate.resolve());
  expect(s.authorized).toHaveLength(0);
  await tick(() => { results = pending([() => s.api.get(summary)]); });
  expect(hasDialog(tree)).toBe(true);
  expect(tree.root.findByType('input').props.value).toBe('');
  await enter(tree);
  await promiseSettles(results, 'fulfilled', 1);
});

it.each(['retry', 'cancel', 'rate limit'])('incorrect PIN does not orphan requests: %s', async action => {
  const s = fakeApi(); const { tree } = await mount(s);
  let results!: Promise<PromiseSettledResult<any>[]>;
  await tick(() => { results = pending([() => s.api.get(payments), () => s.api.get(summary)]); });
  await enter(tree, '0000');
  expect(label(tree)).toContain('INVALID_ADMIN_PIN');
  expect(s.authorized).toHaveLength(0);
  expect(s.attempts).toHaveLength(1);
  if (action === 'retry') { await enter(tree); await enter(tree); }
  else if (action === 'cancel') await cancel(tree);
  else {
    s.setPinFailure({ status: 429, code: 'RATE_LIMIT_EXCEEDED' });
    await enter(tree);
  }
  const settled = await promiseSettles(results, action === 'retry' ? 'fulfilled' : 'rejected', 2);
  if (action === 'rate limit') expect(settled.every(r => r.reason.response.status === 429)).toBe(true);
  expect(hasDialog(tree)).toBe(false);
});

it.each(['owner', 'allowed', 'denied'] as const)('%s remains unchanged and never prompts', async access => {
  const s = fakeApi();
  if (access === 'owner') s.setRole('owner');
  else s.setMode(access);
  const { tree } = await mount(s);
  let results!: Promise<PromiseSettledResult<any>[]>;
  await tick(() => { results = pending([() => s.api.get(payments), () => s.api.get(summary)]); });
  await promiseSettles(results, access === 'denied' ? 'rejected' : 'fulfilled', 2);
  expect(s.attempts).toEqual([]);
  expect(hasDialog(tree)).toBe(false);
});

it('serializes different permissions and protects PATCH from duplicate submit', async () => {
  const s = fakeApi(); const { tree } = await mount(s);
  let results!: Promise<PromiseSettledResult<any>[]>;
  await tick(() => { results = pending([() => s.api.get(summary), () => s.api.patch('/write/foreign', { update: true })]); });
  expect(label(tree)).toContain('Ver finanzas');
  await enter(tree);
  expect(label(tree)).toContain('Gestionar miembros');
  await enter(tree, goodPin, true);
  await promiseSettles(results, 'fulfilled', 2);
  expect(s.authorized.map(({ permission, method }) => [permission, method])).toEqual([[finance, 'get'], ['members.manage', 'patch']]);
  expect(s.attempts).toEqual([finance, 'members.manage']);
});

it('aborting one query removes only that ticket; navigating retires the remaining UI and late challenges', async () => {
  const s = fakeApi(); const ui = await mount(s, true);
  await waitFor(() => expect(s.challenges).toHaveLength(2));
  const gate = s.blockChallenges();
  const caller = new AbortController();
  let manual!: Promise<PromiseSettledResult<any>[]>;
  await tick(() => { manual = pending([() => s.api.get('/protected/abort', { signal: caller.signal }), () => s.api.get('/protected/old-route')]); });
  await tick(() => caller.abort());
  expect(hasDialog(ui.tree)).toBe(true);
  await tick(() => ui.go('/other'));
  await tick(() => gate.resolve());
  const rejected = await promiseSettles(manual, 'rejected', 2);
  expect(rejected.every(r => axios.isCancel(r.reason))).toBe(true);
  expect(s.attempts).toHaveLength(0);
  expect(hasDialog(ui.tree)).toBe(false);
  expect(ui.queryClient.isFetching()).toBe(0);
});

it('aborting an already queued active caller promotes the next one, without issuing any grant', async () => {
  const s = fakeApi(); const { tree } = await mount(s);
  const signal = new AbortController();
  let results!: Promise<PromiseSettledResult<any>[]>;
  await tick(() => { results = pending([() => s.api.get(summary, { signal: signal.signal }), () => s.api.patch('/write/foreign', {})]); });
  expect(label(tree)).toContain('Ver finanzas');
  await tick(() => signal.abort());
  expect(label(tree)).toContain('Gestionar miembros');
  expect(s.attempts).toHaveLength(0);
  await enter(tree);
  expect((await results).map(item => item.status)).toEqual(['rejected', 'fulfilled']);
  expect(s.authorized.map(item => item.url)).toEqual(['/write/foreign']);
});

it.each(['logout', 'identity change'])('real AuthContext cancels pending queries on %s and a late grant cannot proceed', async action => {
  const s = fakeApi(); const ui = await mount(s);
  let results!: Promise<PromiseSettledResult<any>[]>;
  await tick(() => { results = pending([() => s.api.get(payments), () => s.api.get(summary)]); });
  const gate = s.blockPin();
  await enter(ui.tree);
  await act(async () => {
    if (action === 'logout') await ui.auth.logout();
    else {
      const newIdentity = { ...initialIdentity, user: { id: 'profile-b' }, gymUser: { ...initialIdentity.gymUser, id: 'staff-b' } };
      s.setIdentity(newIdentity);
      await ui.auth.refresh({ background: true });
    }
  });
  await promiseSettles(results, 'rejected', 2);
  await tick(() => gate.resolve());
  expect(s.authorized).toHaveLength(0);
  expect(hasDialog(ui.tree)).toBe(false);
});

it.each([
  [{ status: 500, code: 'BACKEND_FAILURE' }, 'post'],
  [{ status: 403, code: 'PERMISSION_DENIED' }, 'patch'],
  [{ status: 403, code: 'REQUIRES_ADMIN_PIN' }, 'delete'],
  [{ status: 401, code: 'INVALID_SESSION' }, 'post'],
  [{ code: 'ECONNABORTED' }, 'patch'],
] as const)('surfaces %o after one elevated %s, without replaying the mutation', async (failure, method) => {
  const s = fakeApi(); const { tree } = await mount(s);
  s.failAfterPin(failure);
  let result!: Promise<PromiseSettledResult<any>[]>;
  await tick(() => { result = pending([() => s.api.request({ url: '/write/test', method, data: { example: true } })]); });
  await enter(tree);
  const [item] = await promiseSettles(result, 'rejected', 1);
  expect(item!.reason.response?.data?.error?.code ?? item!.reason.code).toBe(failure.code);
  expect(adminPin.isAdminPinFailure(item!.reason)).toBe(true);
  expect(s.authorized).toHaveLength(1);
  expect(s.attempts).toHaveLength(1);
  expect(s.sent.filter(url => url === '/auth/refresh')).toHaveLength(0);
  expect(hasDialog(tree)).toBe(false);
});

it('does not dispatch an expired token or automatically reopen elevation', async () => {
  const s = fakeApi(); const { tree } = await mount(s); s.expireGrant();
  let results!: Promise<PromiseSettledResult<any>[]>;
  await tick(() => { results = pending([() => s.api.get(summary)]); });
  await enter(tree);
  const [item] = await promiseSettles(results, 'rejected', 1);
  expect(item!.reason.message).toMatch(/expiró/);
  expect(s.authorized).toHaveLength(0);
  expect(s.attempts).toHaveLength(1);
  expect(hasDialog(tree)).toBe(false);
});

it.each(['cancel', '500'])('React Query exits fetching without reopening PIN after %s', async failure => {
  const s = fakeApi(); const { tree, queryClient } = await mount(s);
  const key = ['protected-default-retry'];
  let results!: Promise<PromiseSettledResult<any>[]>;
  await tick(() => {
    results = pending([() => queryClient.fetchQuery({
      queryKey: key, queryFn: ({ signal }: { signal: AbortSignal }) => s.api.get(summary, { signal }),
    })]);
  });
  if (failure === 'cancel') await cancel(tree);
  else {
    s.failAfterPin({ status: 500, code: 'BACKEND_FAILURE' });
    await enter(tree);
  }
  await promiseSettles(results, 'rejected', 1);
  expect(queryClient.getQueryState(key)).toMatchObject({ status: 'error', fetchStatus: 'idle', fetchFailureCount: 1 });
  expect(s.challenges).toHaveLength(1);
  expect(hasDialog(tree)).toBe(false);
});
