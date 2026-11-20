import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as currentPortalDate from '../../frontend/src/utils/currentPortalDate';
import * as portalTime from '../../frontend/src/utils/portalTime';

const req = createRequire(new URL('../../frontend/package.json', import.meta.url));
const React = req('react');
const { act, create } = req('react-test-renderer');
const { QueryClient, QueryClientProvider, focusManager } = req('@tanstack/react-query');
const api = { get: vi.fn(), post: vi.fn(), patch: vi.fn() };
const session = { gymUser: { gym_id: 'gym-a', id: 'owner-a', role: 'owner', gym: undefined as undefined | { timezone: string } } };
const empty = new Proxy({}, { get: () => () => null });
const summaryUrl = '/members/dashboard-summary';
const attendanceUrl = '/attendances/dashboard-summary';
const incomeUrl = '/member-payments/dashboard-summary';
const summaryKey = (gym = 'gym-a', actor = 'owner-a') => ['dashboard-members-summary', gym, actor];
const mounts: Array<{ tree: any; client: any }> = [];

function load(file: string) {
  const source = readFileSync(new URL(`../../frontend/src/${file}.tsx`, import.meta.url), 'utf8');
  const exports: Record<string, any> = {};
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  });
  new Function('exports', 'require', 'React', outputText)(exports, (id: string) => {
    if (id === '../services/api') return { api, apiErrorMessage: () => 'Error' };
    if (id === '../context/AuthContext') return { useAuth: () => ({ session }) };
    if (id === 'react-router-dom') return { useNavigate: () => vi.fn() };
    if (id === '../utils/currentPortalDate') return currentPortalDate;
    if (id === '../utils/portalTime') return portalTime;
    if (id === '../components/OwnerAnnouncementsPanel') return announcements;
    if (id === 'lucide-react' || id.startsWith('../components/')) return empty;
    return req(id);
  }, React);
  return exports;
}

const announcements = load('components/OwnerAnnouncementsPanel');
const { DashboardPage: Dashboard } = load('pages/DashboardPage');
const { MembersPage: Members } = load('pages/MembersPage');
const { AttendancesPage: Reception } = load('pages/AttendancesPage');
const namedMember = { id: 'last-visit', profiles: { full_name: 'Miembro de prueba' } };
const visit = { id: 'visit', member_user_id: namedMember.id, memberName: namedMember.profiles.full_name, checked_in_at: '2026-11-08T12:00:00Z', currentStreak: 1, status: 'valid', source: 'staff' };
let activeMemberCount: number;

function mockGet(url: string) {
  switch (url) {
    case summaryUrl:
      return { data: { activeMemberCount, members: Array.from({ length: 250 }, (_, i) => (
        i === 0 ? namedMember : { id: `member-${i}`, profiles: null }
      )) } };
    case '/attendances':
      return { data: { attendances: [visit] } };
    case attendanceUrl:
      return { data: { validTodayCount: 1 } };
    case '/attendances/reception':
      return { data: {
        receptionLocation: { id: 'branch-a', name: 'Sede A', is_active: true },
        members: [{ id: 'reception-member', name: 'Miembro de recepción', status: 'active', canCheckIn: true, membership: { id: 'membership' } }],
        attendances: [visit],
      } };
    case '/attendances/streaks':
      return { data: { streaks: [] } };
    case '/member-payments':
      return { data: { payments: [] } };
    case incomeUrl:
      return { data: { summary: { month: currentPortalDate.portalDate(Date.now(), session.gymUser.gym?.timezone).slice(0, 7), currencies: [] } } };
    case '/announcements':
      return { data: { announcements: [], locations: [] } };
    case '/members':
      return { data: { members: [], retiredMembers: [], locations: [] } };
    default:
      throw Error(`Unexpected request: ${url}`);
  }
}

async function mount(component = Dashboard, strict = false) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, gcTime: Infinity, retry: false } } });
  const view = () => {
    const app = React.createElement(QueryClientProvider, { client }, React.createElement(component));
    return strict ? React.createElement(React.StrictMode, null, app) : app;
  };
  let tree: any;
  await act(async () => { tree = create(view()); });
  mounts.push({ tree, client });
  return { tree, client, render: () => act(async () => { tree.update(view()); }) };
}

function metric(tree: any, label = 'Miembros activos') {
  const card = tree.root.findAllByType('article').find((article: any) => (
    article.findAllByType('p').some((p: any) => p.props.children === label)
  ));
  return card.findByType('strong').props.children;
}

function waitFor(assertion: () => void) {
  return vi.waitFor(async () => {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)); });
    assertion();
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  session.gymUser.gym = undefined;
  session.gymUser.role = 'owner';
  activeMemberCount = 251;
  api.get.mockReset().mockImplementation(async (url: string) => mockGet(url));
  api.post.mockReset().mockResolvedValue({ data: {} });
  api.patch.mockReset().mockResolvedValue({ data: {} });
});

afterEach(async () => {
  await act(async () => mounts.forEach(({ tree }) => tree.unmount()));
  mounts.splice(0).forEach(({ client }) => client.clear());
  focusManager.setFocused(undefined);
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it.each([251, 230])('renders the exact %i, not the length of the name lookup', async (count) => {
  activeMemberCount = count;
  const { tree, client } = await mount();
  await waitFor(() => {
    expect(metric(tree)).toBe(String(count));
    expect(metric(tree, 'Asistencias hoy')).toBe('1');
  });
  expect(JSON.stringify(tree.toJSON())).toContain(namedMember.profiles.full_name);
  expect(api.get.mock.calls.filter(([url]) => url === summaryUrl)).toHaveLength(1);
  expect(api.get.mock.calls.map(([url]) => url)).not.toContain('/members');
  expect(client.getQueryData(summaryKey())).toMatchObject({ activeMemberCount: count });
});

it('shows loading and renders a genuine zero only after a successful response', async () => {
  let finish!: (result: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  api.get.mockImplementation(async (url: string) => url === summaryUrl ? pending : mockGet(url));
  const { tree } = await mount();
  expect(metric(tree)).toBe('…');
  await act(async () => { finish({ data: { activeMemberCount: 0, members: [] } }); });
  await waitFor(() => expect(metric(tree)).toBe('0'));
});

it('does not display zero when the summary fails; other cards remain available', async () => {
  api.get.mockImplementation(async (url: string) => {
    if (url === summaryUrl) throw Error('members.view denied');
    return mockGet(url);
  });
  const { tree } = await mount();
  await waitFor(() => {
    expect(metric(tree)).toBe('No disponible');
    expect(metric(tree, 'Asistencias hoy')).toBe('1');
  });
});

it('invalidates the current gym summary after a managed member is created, not other gyms', async () => {
  const { tree, client } = await mount(Members);
  const sameGym = summaryKey('gym-a', 'staff-a');
  const otherGym = summaryKey('gym-b', 'owner-b');
  client.setQueryData(summaryKey(), { activeMemberCount: 4 });
  client.setQueryData(sameGym, { activeMemberCount: 4 });
  client.setQueryData(otherGym, { activeMemberCount: 12 });
  await act(async () => {
    const add = tree.root.findAllByType('button').find((button: any) => (
      button.props.className === 'primary' && button.props.children.includes('Nuevo miembro')
    ));
    add.props.onClick();
  });
  await act(async () => {
    tree.root.findAllByType('select').find((field: any) => field.props.value === 'portal')
      .props.onChange({ target: { value: 'managed' } });
  });
  await act(async () => {
    tree.root.findAllByType('input').find((field: any) => field.props.required && field.props.minLength === 2)
      .props.onChange({ target: { value: 'Nuevo miembro de prueba' } });
  });
  await act(async () => {
    tree.root.findByType('form').props.onSubmit({ preventDefault() {} });
  });
  await waitFor(() => {
    expect(api.post).toHaveBeenCalledWith('/members/managed', expect.objectContaining({ fullName: 'Nuevo miembro de prueba' }));
    expect(client.getQueryState(summaryKey()).isInvalidated).toBe(true);
    expect(client.getQueryState(sameGym).isInvalidated).toBe(true);
    expect(client.getQueryState(otherGym).isInvalidated).toBe(false);
  });
});

it('shows the exact attendance total separately from recent activity, with the same civil day', async () => {
  // In Guayaquil this UTC instant is still on November 17.
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-18T03:00:00Z'));
  api.get.mockImplementation(async (url: string) => url === attendanceUrl
    ? { data: { validTodayCount: 501 } }
    : mockGet(url));
  const { tree, client } = await mount();
  await waitFor(() => {
    expect(metric(tree, 'Asistencias hoy')).toBe('501');
    expect(JSON.stringify(tree.toJSON())).toContain('Asistencia registrada');
  });
  expect(api.get).toHaveBeenCalledWith(attendanceUrl, expect.objectContaining({ params: { date: '2026-11-17' } }));
  expect(api.get).toHaveBeenCalledWith('/attendances', expect.objectContaining({ params: { from: '2026-11-17', to: '2026-11-17' } }));
  expect(client.getQueryData(['dashboard-attendance-summary', 'gym-a', 'owner-a', '2026-11-17', 'America/Guayaquil'])).toBe(501);
});

it('shows loading and a genuine zero even when the operational history fails', async () => {
  let finish!: (result: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  api.get.mockImplementation(async (url: string) => {
    if (url === attendanceUrl) return pending;
    if (url === '/attendances') throw Error('History failed');
    return mockGet(url);
  });
  const { tree } = await mount();
  expect(metric(tree, 'Asistencias hoy')).toBe('…');
  await act(async () => { finish({ data: { validTodayCount: 0 } }); });
  await waitFor(() => expect(metric(tree, 'Asistencias hoy')).toBe('0'));
});

it('does not use a partial history as the fallback when the exact count fails', async () => {
  api.get.mockImplementation(async (url: string) => {
    if (url === attendanceUrl) throw Error('Count failed');
    return mockGet(url);
  });
  const { tree } = await mount();
  await waitFor(() => {
    expect(metric(tree, 'Asistencias hoy')).toBe('No disponible');
    expect(JSON.stringify(tree.toJSON())).toContain('Asistencia registrada');
  });
});

it.each(['register', 'void'] as const)('invalidates only the gym attendance summary after %s succeeds', async action => {
  const { tree, client } = await mount(Reception);
  const sameGymToday = ['dashboard-attendance-summary', 'gym-a', 'owner-a', '2026-11-18'];
  const sameGymOtherDate = ['dashboard-attendance-summary', 'gym-a', 'staff-a', '2026-11-17'];
  const otherGym = ['dashboard-attendance-summary', 'gym-b', 'owner-b', '2026-11-18'];
  const otherMetric = summaryKey();
  for (const key of [sameGymToday, sameGymOtherDate, otherGym, otherMetric]) client.setQueryData(key, 3);
  const button = (predicate: (props: any) => unknown) => tree.root.findAllByType('button').find((item: any) => predicate(item.props));
  await waitFor(() => expect(button(props => props.title === 'Anular asistencia')).toBeDefined());

  if (action === 'register') {
    await act(async () => {
      button(props => props.children.includes('Registrar entrada')).props.onClick();
    });
  } else {
    await act(async () => { button(props => props.title === 'Anular asistencia').props.onClick(); });
    await act(async () => { tree.root.findByType('textarea').props.onChange({ target: { value: 'Corrección local' } }); });
    await act(async () => { tree.root.findByType('form').props.onSubmit({ preventDefault() {} }); });
  }
  await waitFor(() => {
    if (action === 'register') {
      expect(api.post).toHaveBeenCalledWith('/attendances/staff', { locationId: 'branch-a', memberUserId: 'reception-member', membershipId: 'membership' });
    } else {
      expect(api.patch).toHaveBeenCalledWith('/attendances/visit/void', { reason: 'Corrección local' });
    }
    expect(client.getQueryState(sameGymToday).isInvalidated).toBe(true);
    expect(client.getQueryState(sameGymOtherDate).isInvalidated).toBe(true);
    expect(client.getQueryState(otherGym).isInvalidated).toBe(false);
    expect(client.getQueryState(otherMetric).isInvalidated).toBe(false);
  });
});

describe('FIT-OWNER-005 Dashboard civil time', () => {
  const ny = 'America/New_York';
  const gye = 'America/Guayaquil';
  const instant = '2026-11-01T04:30:00Z';
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const settle = () => advance(10);
  const requests = (url: string) => api.get.mock.calls.filter(([path]) => path === url).map(([, options]) => options);
  const requestedDays = () => requests(attendanceUrl).map(options => options.params.date);

  function startClock(time: string, timezone: string) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(time));
    session.gymUser.gym = { timezone };
    const tab = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const browser = new EventTarget();
    vi.stubGlobal('document', tab);
    vi.stubGlobal('window', browser);
    return { tab, browser };
  }

  async function showRollover(from: string, to: string, monthChanges: boolean) {
    let release!: (response: unknown) => void;
    const nextIncome = new Promise(resolve => { release = resolve; });
    function income(month: string, amount: number) {
      return { data: { summary: { month, currencies: [{ currency: 'USD', amount, count: 1,
        categories: Object.fromEntries(['memberships', 'stockSales', 'activities', 'other'].map(k => [k, { amount: 0, count: 0 }])) }] } } };
    }
    api.get.mockImplementation(async (url: string, options) => {
      if (url === incomeUrl) return requests(incomeUrl).length === 1 ? income(from.slice(0, 7), 123) : nextIncome;
      if (url === attendanceUrl) return { data: { validTodayCount: options.params.date === from ? 5 : 8 } };
      if (url === '/attendances') return { data: { attendances: [{ ...visit, source: options.params.from === from ? 'staff' : 'qr' }] } };
      return mockGet(url);
    });
    const { tree } = await mount();
    await settle();
    expect(metric(tree, 'Asistencias hoy')).toBe('5');
    expect(metric(tree, 'Ingresos del mes')).toBe('123.00 USD');
    expect(JSON.stringify(tree.toJSON())).toContain('Registro manual');
    await advance(989);
    expect(requestedDays()).toEqual([from]);
    await advance(1);
    await settle();
    expect(requestedDays()).toEqual([from, to]);
    expect(requests('/attendances').map(options => options.params)).toEqual([{ from, to: from }, { from: to, to }]);
    expect(metric(tree, 'Asistencias hoy')).toBe('8');
    expect(JSON.stringify(tree.toJSON())).not.toContain('Registro manual');
    expect(JSON.stringify(tree.toJSON())).toContain('Registro QR');
    expect(requests(incomeUrl)).toHaveLength(monthChanges ? 2 : 1);
    expect(requests(incomeUrl).every(options => options.params === undefined && options.signal)).toBe(true);
    expect(metric(tree, 'Ingresos del mes')).toBe(monthChanges ? '…' : '123.00 USD');
    if (monthChanges) {
      await act(async () => { release(income(to.slice(0, 7), 456)); });
      await settle();
      expect(metric(tree, 'Ingresos del mes')).toBe('456.00 USD');
    }
  }

  it.each([
    { gym: gye, browser: gye, at: instant, expected: '2026-10-31', role: 'owner' },
    { gym: ny, browser: gye, at: instant, expected: '2026-11-01', role: 'owner' },
    { gym: gye, browser: 'Asia/Tokyo', at: instant, expected: '2026-10-31', role: 'owner' },
    { gym: ny, browser: 'Europe/Madrid', at: '2026-10-31T23:30:00Z', expected: '2026-10-31', role: 'staff' },
  ])('uses $gym for $role in $browser, including feed and announcement timestamps', async ({ gym, browser, at, expected, role }) => {
    vi.stubEnv('TZ', browser);
    startClock(at, gym);
    session.gymUser.role = role;
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(browser);
    const config = { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' } as const;
    api.get.mockImplementation(async (url: string) => {
      if (url === '/attendances') return { data: { attendances: [{ ...visit, checked_in_at: at }] } };
      if (url === '/member-payments') return { data: { payments: [{ id: 'pay', status: 'confirmed', paid_at: instant, amount: 9, currency: 'USD' }] } };
      if (url === '/announcements') return { data: { announcements: [{ id: 'notice', body: 'Aviso de prueba', location_id: null, created_at: at }], locations: [] } };
      return mockGet(url);
    });
    const { tree, client } = await mount();
    await settle();
    expect(requestedDays()).toEqual([expected]);
    expect(requests('/attendances')[0].params).toEqual({ from: expected, to: expected });
    expect(client.getQueryState(['dashboard-income-summary', 'gym-a', 'owner-a', expected.slice(0, 7), gym]).status).toBe('success');
    const formatted = tree.root.findAllByType('time').map((time: any) => time.props.children);
    expect(formatted).toEqual([instant, at].map(value => new Date(value).toLocaleString('es-EC', { ...config, timeZone: gym })));
    if (gym !== browser) expect(formatted).not.toEqual([instant, at].map(value => new Date(value).toLocaleString('es-EC', { ...config, timeZone: browser })));
    const notice = tree.root.findAllByProps({ className: 'announcement-item' });
    if (role === 'owner') {
      expect(notice[0].findByType('small').props.children.join('')).toBe(`Todas las sucursales · ${new Date(at).toLocaleDateString('es-EC', { timeZone: gym })}`);
    } else {
      expect(notice).toHaveLength(0);
      expect(requests('/announcements')).toHaveLength(0);
    }
  });

  it.each([
    [gye, '2026-11-20T04:59:59Z', '2026-11-19', '2026-11-20', false],
    [ny, '2026-11-01T03:59:59Z', '2026-10-31', '2026-11-01', true],
    [gye, '2027-01-01T04:59:59Z', '2026-12-31', '2027-01-01', true],
  ] as const)('at midnight in %s (%s), atomically changes the day and only refetches income for a new month', async (zone, at, from, to, monthChanges) => {
    startClock(at, zone);
    const interval = vi.spyOn(globalThis, 'setInterval');
    await showRollover(from, to, monthChanges);
    expect(interval).not.toHaveBeenCalled();
  });

  it.each([
    ['2026-03-08T05:00:00Z', 23, '2026-03-08', '2026-03-09'],
    ['2026-11-01T04:00:00Z', 25, '2026-11-01', '2026-11-02'],
  ] as const)('waits for the actual next midnight (%s, %ih)', async (at, hours, from, to) => {
    startClock(at, ny);
    await mount();
    await advance(hours * 3_600_000 - 1);
    expect(requestedDays()).toEqual([from]);
    await advance(1);
    await settle();
    expect(requestedDays()).toEqual([from, to]);
  });

  it.each(['focus', 'visibilitychange'] as const)('resyncs after missed midnight on %s and schedules the next one', async (event) => {
    const { tab, browser } = startClock('2026-10-31T23:00:00Z', ny);
    await mount();
    await settle();
    tab.visibilityState = 'hidden';
    await act(async () => { focusManager.setFocused(false); tab.dispatchEvent(new Event('visibilitychange')); });
    vi.setSystemTime(new Date('2026-11-01T13:00:00Z'));
    await act(async () => { tab.dispatchEvent(new Event('visibilitychange')); });
    expect(requestedDays()).toEqual(['2026-10-31']);
    await act(async () => {
      tab.visibilityState = 'visible';
      focusManager.setFocused(true); // React Query can receive this event before the Dashboard render commits.
      (event === 'focus' ? browser : tab).dispatchEvent(new Event(event));
    });
    await settle();
    expect(requestedDays()).toEqual(['2026-10-31', '2026-11-01']);
    expect(requests('/attendances').map(options => options.params.from)).toEqual(requestedDays());
    expect(requests(incomeUrl)).toHaveLength(2);
    await advance(Date.parse('2026-11-02T05:00:00Z') - Date.now());
    await settle();
    expect(requestedDays()).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('changes all period keys and reprograms when session timezone changes, even for an unchanged date', async () => {
    startClock('2026-11-01T03:59:59Z', gye);
    const { client, render } = await mount();
    await settle();
    session.gymUser.gym = { timezone: ny };
    await render();
    await settle();
    expect(requestedDays()).toEqual(['2026-10-31', '2026-10-31']);
    expect(client.getQueryState(['dashboard-income-summary', 'gym-a', 'owner-a', '2026-10', ny]).status).toBe('success');
    await advance(Date.parse('2026-11-01T04:00:00Z') - Date.now());
    await settle();
    expect(requestedDays()).toEqual(['2026-10-31', '2026-10-31', '2026-11-01']);
    expect(requests(incomeUrl)).toHaveLength(3);
    expect(client.getQueryState(['dashboard-income-summary', 'gym-a', 'owner-a', '2026-11', ny]).status).toBe('success');
    await advance(3_600_000);
    expect(requestedDays()).toHaveLength(3);
  });

  it('uses the new session date immediately when the new timezone is already in another month', async () => {
    startClock(instant, gye);
    const { client, render } = await mount();
    await settle();
    session.gymUser.gym = { timezone: ny };
    await render();
    await settle();
    expect(requestedDays()).toEqual(['2026-10-31', '2026-11-01']);
    expect(requests('/attendances').map(options => options.params.from)).toEqual(requestedDays());
    expect(requests(incomeUrl)).toHaveLength(2);
    expect(client.getQueryState(['dashboard-income-summary', 'gym-a', 'owner-a', '2026-11', ny]).status).toBe('success');
    expect(client.getQueryState(['dashboard-attendance-summary', 'gym-a', 'owner-a', '2026-10-31', ny])).toBeUndefined();
  });

  it('does not render a prior-month RPC response as income for the new month', async () => {
    const { browser } = startClock(instant, ny);
    api.get.mockImplementation(async (url: string) =>
      url === incomeUrl && requests(incomeUrl).length === 1 ? { data: { summary: { month: '2026-10', currencies: [] } } } : mockGet(url));
    const { tree } = await mount();
    await settle();
    expect(metric(tree, 'Ingresos del mes')).toBe('No disponible');
    expect(JSON.stringify(tree.toJSON())).toContain('no corresponde al mes actual');
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      browser.dispatchEvent(new Event('focus'));
    });
    await settle();
    expect(requests(incomeUrl)).toHaveLength(2);
    expect(metric(tree, 'Ingresos del mes')).toBe('0.00 USD');
  });

  it('disposes timers and listeners on repeated mounts, including StrictMode effect replay', async () => {
    const { tab, browser } = startClock('2026-11-19T04:59:58Z', gye);
    const added = [vi.spyOn(tab, 'addEventListener'), vi.spyOn(browser, 'addEventListener')];
    const removed = [vi.spyOn(tab, 'removeEventListener'), vi.spyOn(browser, 'removeEventListener')];
    for (let i = 0; i < 2; i += 1) {
      const { tree, client } = await mount(Dashboard, true);
      await settle();
      expect(vi.getTimerCount()).toBe(1);
      await act(async () => { tree.unmount(); });
      mounts.pop();
      client.clear();
      expect(vi.getTimerCount()).toBe(0);
    }
    for (const [index, event] of ['visibilitychange', 'focus'].entries()) {
      const listeners = added[index].mock.calls.filter(([type]) => type === event);
      expect(listeners.length).toBeGreaterThanOrEqual(2);
      expect(removed[index].mock.calls.filter(([type]) => type === event)).toHaveLength(listeners.length);
      for (const call of listeners) expect(removed[index]).toHaveBeenCalledWith(...call);
    }
    const before = requestedDays();
    browser.dispatchEvent(new Event('focus'));
    tab.dispatchEvent(new Event('visibilitychange'));
    await advance(2000);
    expect(requestedDays()).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
  });
});
