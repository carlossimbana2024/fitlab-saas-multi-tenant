import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const req = createRequire(new URL('../../frontend/package.json', import.meta.url));
const React = req('react');
const { act, create } = req('react-test-renderer');
const { QueryClient, QueryClientProvider } = req('@tanstack/react-query');
const api = { get: vi.fn(), post: vi.fn() };
const session = { gymUser: { gym_id: 'gym-a', id: 'owner-a', role: 'owner' } };
const empty = new Proxy({}, { get: () => () => null });
const summaryUrl = '/members/dashboard-summary';
const summaryKey = (gym = 'gym-a', actor = 'owner-a') => ['dashboard-members-summary', gym, actor];
const mounts: Array<{ tree: any; client: any }> = [];

function loadPage(name: 'DashboardPage' | 'MembersPage') {
  const source = readFileSync(new URL(`../../frontend/src/pages/${name}.tsx`, import.meta.url), 'utf8');
  const exports: Record<string, any> = {};
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  });
  new Function('exports', 'require', 'React', outputText)(exports, (id: string) => {
    if (id === '../services/api') return { api, apiErrorMessage: () => 'Error' };
    if (id === '../context/AuthContext') return { useAuth: () => ({ session }) };
    if (id === 'react-router-dom') return { useNavigate: () => vi.fn() };
    if (id === 'lucide-react' || id.startsWith('../components/')) return empty;
    return req(id);
  }, React);
  return exports[name];
}

const Dashboard = loadPage('DashboardPage');
const Members = loadPage('MembersPage');
const namedMember = { id: 'last-visit', profiles: { full_name: 'Miembro de prueba' } };
let activeMemberCount: number;

function mockGet(url: string) {
  switch (url) {
    case summaryUrl:
      return { data: { activeMemberCount, members: Array.from({ length: 250 }, (_, i) => (
        i === 0 ? namedMember : { id: `member-${i}`, profiles: null }
      )) } };
    case '/attendances':
      return { data: { attendances: [{ id: 'visit', member_user_id: namedMember.id, checked_in_at: '2026-11-08T12:00:00Z', status: 'valid', source: 'staff' }] } };
    case '/attendances/streaks':
      return { data: { streaks: [] } };
    case '/member-payments':
      return { data: { payments: [] } };
    case '/member-payments/dashboard-summary':
      return { data: { summary: { currencies: [] } } };
    case '/members':
      return { data: { members: [], retiredMembers: [], locations: [] } };
    default:
      throw Error(`Unexpected request: ${url}`);
  }
}

async function mount(component = Dashboard) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, gcTime: Infinity, retry: false } } });
  let tree: any;
  await act(async () => {
    tree = create(React.createElement(QueryClientProvider, { client }, React.createElement(component)));
  });
  mounts.push({ tree, client });
  return { tree, client };
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
  activeMemberCount = 251;
  api.get.mockReset().mockImplementation(async (url: string) => mockGet(url));
  api.post.mockReset().mockResolvedValue({ data: {} });
});

afterEach(async () => {
  await act(async () => mounts.forEach(({ tree }) => tree.unmount()));
  mounts.splice(0).forEach(({ client }) => client.clear());
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
