import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), refreshSession: vi.fn(), signInWithPassword: vi.fn(), signOut: vi.fn(), resetPasswordForEmail: vi.fn() }));
vi.mock('../src/config/env.js', () => ({ env: { NODE_ENV: 'production', frontendOrigins: ['https://fitlab.test'] } }));
vi.mock('../src/config/stripe.js', () => ({ stripe: {} }));
vi.mock('../src/services/memberProfile.service.js', () => ({ signAvatarUrl: vi.fn() }));
vi.mock('../src/config/supabase.js', () => ({ supabasePublic: { auth: mocks }, supabaseAdmin: { auth: { admin: mocks } }, createUserSupabaseClient: () => ({ scoped: true }) }));
import { login, logout, refresh, requestPasswordReset, me } from '../src/controllers/auth.controller.js';
import { verifyJWT } from '../src/middlewares/verifyJWT.js';

const valid = { data: { session: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }, user: { id: 'member', email: 'member@example.test' } }, error: null };
const request = (cookies: any = { fitlab_refresh_token: 'refresh-cookie' }) => ({ signedCookies: cookies, headers: {}, body: {} }) as any;
function response() { const res: any = { cookie: vi.fn(), clearCookie: vi.fn(), json: vi.fn(), status: vi.fn(), send: vi.fn() }; res.status.mockReturnValue(res); return res; }
const verify = (req: any) => new Promise<any>(resolve => { verifyJWT(req, response(), resolve); });
beforeEach(() => { vi.resetAllMocks(); });

describe('auth middleware and cookie contracts', () => {
  it.each([{timezone:'Europe/Madrid'},[{timezone:'America/Guayaquil'}]])('FIT-MEMBER-013 exposes the authenticated gym timezone',async gym=>{
    const q:any={select:vi.fn(()=>q),eq:vi.fn(()=>q),single:vi.fn(async()=>({data:{id:'member',gym_id:'gym',gym,profiles:null},error:null}))};
    const req:any={authUser:{id:'profile'},supabase:{from:vi.fn(()=>q)}},res=response();
    await me(req,res);
    expect(q.select.mock.calls[0][0]).toContain('gym:gyms!gym_users_gym_id_fkey(timezone)');
    expect(q.eq).toHaveBeenCalledWith('profile_id','profile');
    expect(res.json.mock.calls[0][0].gymUser.gym).toEqual(Array.isArray(gym)?gym[0]:gym);
  });
  it.each(['owner', 'staff', 'member'])('me resolves the tenant FK when PostgREST exposes multiple gym relationships (%s)', async role => {
    let selected = '';
    const gymUser = { id: 'gym-user', gym_id: 'own-gym', role, gym: { timezone: 'America/Guayaquil' }, profiles: null };
    const q: any = {
      select: vi.fn((columns: string) => { selected = columns; return q; }),
      eq: vi.fn(() => q),
      single: vi.fn(async () => selected.includes('gym:gyms!gym_users_gym_id_fkey(timezone)')
        ? { data: gymUser, error: null }
        : { data: null, error: { code: 'PGRST201', message: "Could not embed because more than one relationship was found for 'gym_users' and 'gyms'" } }),
    };
    const req: any = { authUser: { id: 'authenticated-profile' }, query: { gym_id: 'other-gym' }, supabase: { from: vi.fn(() => q) } };
    const res = response();
    await me(req, res);
    expect(req.supabase.from).toHaveBeenCalledWith('gym_users');
    expect(q.eq).toHaveBeenCalledWith('profile_id', 'authenticated-profile');
    expect(selected).toContain('staff_permissions!staff_permissions_staff_user_id_fkey');
    expect(res.json).toHaveBeenCalledWith({ user: req.authUser, gymUser, onboardingRequired: false });
    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.clearCookie).not.toHaveBeenCalled();
  });
  it('refresh rotates signed HTTP-only cookies without exposing tokens in JSON', async () => {
    mocks.refreshSession.mockResolvedValue(valid); const res = response(); await refresh(request(), res);
    expect(mocks.refreshSession).toHaveBeenCalledWith({ refresh_token: 'refresh-cookie' });
    expect(res.cookie).toHaveBeenCalledWith('fitlab_access_token', 'new-access', expect.objectContaining({ httpOnly: true, signed: true, secure: true, sameSite: 'none', path: '/' }));
    expect(res.json).toHaveBeenCalledWith({ user: valid.data.user });
  });
  it('invalid refresh clears both cookies', async () => {
    mocks.refreshSession.mockResolvedValue({ data: { session: null }, error: { status: 400 } }); const res = response();
    await expect(refresh(request(), res)).rejects.toMatchObject({ statusCode: 401, code: 'INVALID_REFRESH_TOKEN' });
    expect(res.clearCookie.mock.calls.map((c: any) => c[0])).toEqual(['fitlab_access_token', 'fitlab_refresh_token']);
  });
  it('missing refresh clears residual cookies without contacting Auth', async () => {
    const res = response(); await expect(refresh(request({}), res)).rejects.toMatchObject({ statusCode: 401, code: 'REFRESH_TOKEN_REQUIRED' });
    expect(res.clearCookie).toHaveBeenCalledTimes(2); expect(mocks.refreshSession).not.toHaveBeenCalled();
  });
  it.each([500, 502, 503])('refresh upstream %i preserves cookies and returns retryable 503', async status => {
    mocks.refreshSession.mockResolvedValue({ data: { session: null }, error: { status } }); const res = response();
    await expect(refresh(request(), res)).rejects.toMatchObject({ statusCode: 503 }); expect(res.clearCookie).not.toHaveBeenCalled();
  });
  it('verifyJWT preserves authenticated user and user-scoped client', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: valid.data.user }, error: null }); const req = request({ fitlab_access_token: 'access' });
    expect(await verify(req)).toBeUndefined(); expect(req.authUser).toEqual(valid.data.user); expect(req.supabase).toEqual({ scoped: true });
  });
  it('verifyJWT differentiates invalid access and Auth outage', async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: { status: 401 } });
    expect(await verify(request({ fitlab_access_token: 'old' }))).toMatchObject({ statusCode: 401, code: 'INVALID_SESSION' });
    mocks.getUser.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await verify(request({ fitlab_access_token: 'old' }))).toMatchObject({ statusCode: 503, code: 'AUTH_SERVICE_UNAVAILABLE' });
  });
  it('normal login still sets both cookies', async () => {
    mocks.signInWithPassword.mockResolvedValue(valid); const req = request(); req.body = { email: 'member@example.test', password: 'password123' }; const res = response();
    await login(req, res); expect(res.cookie).toHaveBeenCalledTimes(2); expect(res.status).toHaveBeenCalledWith(200);
  });
  it('logout still revokes the local session and clears cookies', async () => {
    mocks.signOut.mockResolvedValue({ error: null }); const res = response(); await logout(request({ fitlab_access_token: 'access' }), res);
    expect(mocks.signOut).toHaveBeenCalledWith('access', 'local'); expect(res.clearCookie).toHaveBeenCalledTimes(2);
  });
  it('password recovery still uses the existing reset redirect', async () => {
    mocks.resetPasswordForEmail.mockResolvedValue({ error: null }); const req = request(); req.body = { email: 'member@example.test' };
    await requestPasswordReset(req, response()); expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith('member@example.test', expect.objectContaining({ redirectTo: expect.stringContaining('/reset-password') }));
  });
});
