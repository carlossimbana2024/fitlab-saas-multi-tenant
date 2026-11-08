import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ verify: vi.fn(), update: vi.fn() }));
vi.mock('../src/config/env.js', () => ({ env: { NODE_ENV: 'production', frontendOrigins: ['https://fitlab.test'] } }));
vi.mock('../src/config/stripe.js', () => ({ stripe: {} }));
vi.mock('../src/services/memberProfile.service.js', () => ({ signAvatarUrl: vi.fn() }));
vi.mock('../src/config/supabase.js', () => ({
  supabasePublic: { auth: { signInWithPassword: auth.verify } },
  supabaseAdmin: { auth: { admin: { updateUserById: auth.update } } },
  createUserSupabaseClient: vi.fn(),
}));
import { changePassword } from '../src/controllers/auth.controller.js';

// Synthetic inputs only; assertions intentionally avoid printing credential payloads.
const request = (body = { currentPassword: 'fixture-current', newPassword: 'fixture-next' }) => ({
  body, authUser: { id: 'authenticated-member', email: 'fixture@example.test' },
}) as any;
const response = () => ({ json: vi.fn(), cookie: vi.fn(), clearCookie: vi.fn() }) as any;
beforeEach(() => {
  vi.resetAllMocks();
  auth.verify.mockResolvedValue({ data: {}, error: null });
  auth.update.mockResolvedValue({ data: {}, error: null });
});

describe('FIT-MEMBER-017 password operation boundaries', () => {
  it('reports success only after verification and update, without changing session cookies', async () => {
    const res = response();
    await changePassword(request(), res);
    expect(auth.verify).toHaveBeenCalledTimes(1);
    expect(auth.update).toHaveBeenCalledTimes(1);
    expect(auth.verify.mock.invocationCallOrder[0]).toBeLessThan(auth.update.mock.invocationCallOrder[0]!);
    expect(res.json).toHaveBeenCalledWith({ message: 'Contraseña actualizada correctamente.' });
    expect(res.cookie).not.toHaveBeenCalled();
    expect(res.clearCookie).not.toHaveBeenCalled();
  });
  it('wrong current password does not update Auth or return success', async () => {
    auth.verify.mockResolvedValue({ error: { status: 400, code: 'invalid_credentials' } });
    const res = response();
    await expect(changePassword(request(), res)).rejects.toMatchObject({ statusCode: 401, code: 'CURRENT_PASSWORD_INVALID' });
    expect(auth.update).not.toHaveBeenCalled(); expect(res.json).not.toHaveBeenCalled();
    expect(res.clearCookie).not.toHaveBeenCalled();
  });
  it.each([429, 500, 503])('verification upstream status %i is not a wrong-password error', async status => {
    auth.verify.mockResolvedValue({ error: { status } }); const res = response();
    await expect(changePassword(request(), res)).rejects.toMatchObject({ statusCode: 503, code: 'AUTH_SERVICE_UNAVAILABLE' });
    expect(auth.update).not.toHaveBeenCalled(); expect(res.json).not.toHaveBeenCalled();
  });
  it('verification transport failure preserves the session and never updates Auth', async () => {
    auth.verify.mockRejectedValue(new TypeError('fetch failed')); const res = response();
    await expect(changePassword(request(), res)).rejects.toMatchObject({ statusCode: 503, code: 'AUTH_SERVICE_UNAVAILABLE' });
    expect(auth.update).not.toHaveBeenCalled(); expect(res.clearCookie).not.toHaveBeenCalled();
  });
  it.each([429, 500, 503])('update upstream status %i cannot produce success', async status => {
    auth.update.mockResolvedValue({ error: { status } }); const res = response();
    await expect(changePassword(request(), res)).rejects.toMatchObject({ statusCode: 503, code: 'AUTH_SERVICE_UNAVAILABLE' });
    expect(auth.verify).toHaveBeenCalledTimes(1); expect(auth.update).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled(); expect(res.clearCookie).not.toHaveBeenCalled();
  });
  it('update transport failure cannot produce success', async () => {
    auth.update.mockRejectedValue(new TypeError('fetch failed')); const res = response();
    await expect(changePassword(request(), res)).rejects.toMatchObject({ statusCode: 503, code: 'AUTH_SERVICE_UNAVAILABLE' });
    expect(res.json).not.toHaveBeenCalled(); expect(res.cookie).not.toHaveBeenCalled();
  });
  it('ordinary update refusal retains the existing error contract', async () => {
    auth.update.mockResolvedValue({ error: { status: 422 } }); const res = response();
    await expect(changePassword(request(), res)).rejects.toMatchObject({ statusCode: 400, code: 'PASSWORD_UPDATE_FAILED' });
    expect(res.json).not.toHaveBeenCalled();
  });
  it.each([
    { currentPassword: 'short', newPassword: 'fixture-next' },
    { currentPassword: 'fixture-current', newPassword: 'short' },
    { currentPassword: 'fixture-current', newPassword: 'fixture-current' },
  ])('invalid schema prevents both remote operations %#', async body => {
    const res = response();
    await expect(changePassword(request(body), res)).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_PASSWORD_CHANGE_INPUT' });
    expect(auth.verify).not.toHaveBeenCalled(); expect(auth.update).not.toHaveBeenCalled();
  });
});
