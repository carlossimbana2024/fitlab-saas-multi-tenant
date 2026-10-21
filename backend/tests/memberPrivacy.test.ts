import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
const db = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../src/config/supabase.js', () => ({ supabaseAdmin: db }));
import { updateMyPrivacy, upsertMyFitnessProfile } from '../src/controllers/member.controller.js';

const req = (body: object, role = 'member') => ({
  body, tenant: { gymId: 'gym-a', gymUserId: 'member-a', role },
}) as unknown as Request;
const res = () => ({ json: vi.fn() }) as unknown as Response;
const sports = { weightKg: 80, heightCm: 175, goalType: 'improve_fitness' };

describe('member privacy partial-write boundary', () => {
  beforeEach(() => { db.rpc.mockReset(); });

  it('sends only the explicit preference and authenticated identity', async () => {
    db.rpc.mockResolvedValue({ data: { show_streak: true }, error: null });
    const response = res();
    await updateMyPrivacy(req({ key: 'showStreak', value: true }), response);
    expect(db.rpc).toHaveBeenCalledWith('update_member_privacy_backend', {
      target_gym_id: 'gym-a', target_member_user_id: 'member-a',
      preference_key: 'show_streak', preference_value: true,
    });
    expect(response.json).toHaveBeenCalledWith({ fitnessProfile: { show_streak: true } });
  });

  it('does not forward stale unrelated consent from a second client', async () => {
    // RPC model tests the HTTP boundary; the SQL companion exercises real SQL.
    const stored = { show_in_community: true, show_streak: false };
    const clientA = { ...stored };
    const clientB = { ...stored };
    db.rpc.mockImplementation(async (_name, args) => {
      Object.assign(stored, { [args.preference_key]: args.preference_value });
      return { data: { ...stored }, error: null };
    });
    await updateMyPrivacy(req({ key: 'showInCommunity', value: !clientA.show_in_community }), res());
    await updateMyPrivacy(req({ key: 'showStreak', value: !clientB.show_streak }), res());
    expect(stored).toEqual({ show_in_community: false, show_streak: true });
  });

  it('omits privacy on sports edits and preserves explicit onboarding false/true', async () => {
    db.rpc.mockResolvedValue({ data: { id: 'profile' }, error: null });
    await upsertMyFitnessProfile(req(sports), res());
    const args = db.rpc.mock.calls[0]![1];
    for (const [key, value] of Object.entries(args)) {
      if (key.startsWith('supplied_show_')) expect(value).toBeNull();
    }
    await upsertMyFitnessProfile(req({ ...sports, showInCommunity: true, showStreak: false }), res());
    expect(db.rpc.mock.calls[1]![1]).toMatchObject({
      supplied_show_in_community: true, supplied_show_streak: false,
    });
  });

  it.each([
    { key: 'showStreak', value: true, showInCommunity: true },
    { key: 'showStreak', value: true, memberId: 'other' },
    { key: 'weightKg', value: true },
    { key: 'showStreak', value: 'false' },
    {},
  ])('rejects invalid or full-snapshot patches: %j', async body => {
    await expect(updateMyPrivacy(req(body), res())).rejects.toMatchObject({ statusCode: 400 });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('rejects non-members', async () => {
    await expect(updateMyPrivacy(req({ key: 'showStreak', value: true }, 'owner'), res()))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('returns a conflict when the database rejects an outdated legacy snapshot', async () => {
    db.rpc.mockResolvedValue({ data: null, error: { message: 'MEMBER_PRIVACY_REQUIRES_PARTIAL_UPDATE' } });
    await expect(upsertMyFitnessProfile(req({ ...sports, showInCommunity: true }), res()))
      .rejects.toMatchObject({ statusCode: 409 });
  });
});
