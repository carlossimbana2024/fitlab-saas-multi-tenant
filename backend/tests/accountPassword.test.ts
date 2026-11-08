import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ verify: vi.fn(), adminUpdate: vi.fn(), fetch: vi.fn() }));
vi.mock('../src/config/env.js', () => ({ env: { NODE_ENV: 'production', frontendOrigins: ['https://fitlab.test'],
  SUPABASE_URL: 'https://auth.invalid', SUPABASE_PUBLISHABLE_KEY: 'fixture-public' } }));
vi.mock('../src/config/stripe.js', () => ({ stripe: {} }));
vi.mock('../src/services/memberProfile.service.js', () => ({ signAvatarUrl: vi.fn() }));
vi.mock('../src/config/supabase.js', () => ({
  supabasePublic: { auth: { signInWithPassword: auth.verify } },
  supabaseAdmin: { auth: { admin: { updateUserById: auth.adminUpdate } } }, createUserSupabaseClient: vi.fn(),
}));
import { changePassword } from '../src/controllers/auth.controller.js';

// Synthetic inputs only. Never include credentials or bearer headers in failing assertions.
const request = (body = { currentPassword: 'fixture-current', newPassword: 'fixture-next' }) => ({
  body, accessToken: 'fixture-access', authUser: { id: 'authenticated-member', email: 'fixture@example.test' },
}) as any;
const response = () => ({ json: vi.fn(), cookie: vi.fn(), clearCookie: vi.fn() }) as any;
const upstream = (status = 200, body: object = { id: 'authenticated-member' }) => new Response(JSON.stringify(body), { status });
beforeEach(() => {
  vi.resetAllMocks(); auth.verify.mockResolvedValue({ data: {}, error: null });
  auth.fetch.mockImplementation(async () => upstream()); vi.stubGlobal('fetch', auth.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe('FIT-MEMBER-017 password operation boundaries', () => {
  it('uses the verified caller session instead of the administrative password reset; no cookie changes', async () => {
    const res = response(); const input = request(); await changePassword(input, res);
    expect(auth.verify).toHaveBeenCalledTimes(1); expect(auth.fetch).toHaveBeenCalledTimes(1);
    expect(auth.verify.mock.invocationCallOrder[0]).toBeLessThan(auth.fetch.mock.invocationCallOrder[0]!);
    const [url, options] = auth.fetch.mock.calls[0]!;
    expect(url).toBe('https://auth.invalid/auth/v1/user'); expect(options.method).toBe('PUT');
    expect(options.headers.Authorization === `Bearer ${input.accessToken}`).toBe(true);
    expect(options.headers.apikey === 'fixture-public').toBe(true);
    const body = JSON.parse(options.body);
    expect(body.password === input.body.newPassword && body.current_password === input.body.currentPassword).toBe(true);
    expect(auth.adminUpdate).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ message: 'Contraseña actualizada correctamente.' });
    expect(res.cookie).not.toHaveBeenCalled(); expect(res.clearCookie).not.toHaveBeenCalled();
  });
  it('wrong current password does not update Auth or return success', async () => {
    auth.verify.mockResolvedValue({ error: { status: 400, code: 'invalid_credentials' } }); const res = response();
    await expect(changePassword(request(), res)).rejects.toMatchObject({ statusCode: 401, code: 'CURRENT_PASSWORD_INVALID' });
    expect(auth.fetch).not.toHaveBeenCalled(); expect(res.json).not.toHaveBeenCalled(); expect(res.clearCookie).not.toHaveBeenCalled();
  });
  it.each([429, 500, 503])('verification upstream status %i is not a wrong-password error', async status => {
    auth.verify.mockResolvedValue({ error: { status } }); const res = response();
    await expect(changePassword(request(), res)).rejects.toMatchObject({ statusCode: 503, code: 'AUTH_SERVICE_UNAVAILABLE' });
    expect(auth.fetch).not.toHaveBeenCalled(); expect(res.json).not.toHaveBeenCalled();
  });
  it('verification transport failure preserves the session and never updates Auth', async () => {
    auth.verify.mockRejectedValue(new TypeError('fetch failed')); const res = response();
    await expect(changePassword(request(), res)).rejects.toMatchObject({ statusCode: 503, code: 'AUTH_SERVICE_UNAVAILABLE' });
    expect(auth.fetch).not.toHaveBeenCalled(); expect(res.clearCookie).not.toHaveBeenCalled();
  });
  it.each([429, 500, 503])('update upstream status %i cannot produce success or clear cookies', async status => {
    auth.fetch.mockResolvedValue(upstream(status, {})); const res = response();
    await expect(changePassword(request(), res)).rejects.toMatchObject({ statusCode: 503, code: 'AUTH_SERVICE_UNAVAILABLE' });
    expect(res.json).not.toHaveBeenCalled(); expect(res.clearCookie).not.toHaveBeenCalled();
  });
  it('update transport failure cannot produce success', async () => {
    auth.fetch.mockRejectedValue(new TypeError('fetch failed')); const res = response();
    await expect(changePassword(request(), res)).rejects.toMatchObject({ statusCode: 503, code: 'AUTH_SERVICE_UNAVAILABLE' });
    expect(res.json).not.toHaveBeenCalled(); expect(res.cookie).not.toHaveBeenCalled();
  });
  it('ordinary update refusal retains the existing error contract', async () => {
    auth.fetch.mockResolvedValue(upstream(422, { code: 'weak_password' })); const res = response();
    await expect(changePassword(request(), res)).rejects.toMatchObject({ statusCode: 400, code: 'PASSWORD_UPDATE_FAILED' });
    expect(res.json).not.toHaveBeenCalled();
  });
  it.each(['reauthentication_needed', 'reauthentication_not_valid', 'insufficient_aal'])('reports provider requirement %s without false success or logout', async code => {
    auth.fetch.mockResolvedValue(upstream(400, { code })); const res = response();
    await expect(changePassword(request(), res)).rejects.toMatchObject({ statusCode: 400, code: 'PASSWORD_REAUTHENTICATION_REQUIRED' });
    expect(res.json).not.toHaveBeenCalled(); expect(res.clearCookie).not.toHaveBeenCalled();
  });
  it('a genuinely rejected caller token remains distinguishable from an outage', async () => {
    auth.fetch.mockResolvedValue(upstream(401, { code: 'session_not_found' })); const res = response();
    await expect(changePassword(request(), res)).rejects.toMatchObject({ statusCode: 401, code: 'INVALID_SESSION' });
    expect(res.json).not.toHaveBeenCalled();
  });
  it.each([{}, { id: 'different-user' }])('unconfirmed/mismatched success never marks password saved %#', async data => {
    auth.fetch.mockResolvedValue(upstream(200, data)); const res = response();
    await expect(changePassword(request(), res)).rejects.toMatchObject({ statusCode: 503, code: 'AUTH_SERVICE_UNAVAILABLE' });
    expect(res.json).not.toHaveBeenCalled();
  });
  it('invalid upstream JSON is retryable, not a wrong password or successful update', async () => {
    auth.fetch.mockResolvedValue(new Response('invalid response', { status: 200 })); const res = response();
    await expect(changePassword(request(), res)).rejects.toMatchObject({ statusCode: 503 }); expect(res.json).not.toHaveBeenCalled();
  });
  it.each([
    { currentPassword: 'short', newPassword: 'fixture-next' },
    { currentPassword: 'fixture-current', newPassword: 'short' },
    { currentPassword: 'fixture-current', newPassword: 'fixture-current' },
  ])('invalid schema prevents both remote operations %#', async body => {
    const res = response();
    await expect(changePassword(request(body), res)).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_PASSWORD_CHANGE_INPUT' });
    expect(auth.verify).not.toHaveBeenCalled(); expect(auth.fetch).not.toHaveBeenCalled();
  });
});
