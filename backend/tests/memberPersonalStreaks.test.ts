import { beforeEach, describe, expect, it, vi } from 'vitest';
const db=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('../src/config/supabase.js',()=>({supabaseAdmin:db}));
import { memberPersonalStreaks, memberPersonalStreaksSchema } from '../src/services/memberPersonalStreaks.service.js';
import { personalStreakLabels, streakQuantity } from '../../frontend/src/utils/memberStreaks';
import { getMyPersonalStreaks } from '../src/controllers/member.controller.js';
import type { Request, Response } from 'express';
const value={weeklyCurrentStreak:4,weeklyBestStreak:8,dailyCurrentStreak:2,dailyBestStreak:10,weeklyStatus:'available' as const,today:'2026-11-12'};
beforeEach(()=>vi.clearAllMocks());
describe('FIT-MEMBER-020 API/UI contract',()=>{
  it('serves canonical metrics only to the authenticated member, without shared caching',async()=>{
    const request={tenant:{role:'member',gymId:'gym',gymUserId:'member'},query:{memberId:'another',timezone:'UTC'}} as unknown as Request;
    const response={json:vi.fn(),setHeader:vi.fn()} as unknown as Response;
    db.rpc.mockResolvedValue({data:value,error:null});
    await getMyPersonalStreaks(request,response);
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith('get_member_personal_streaks_backend',{target_gym_id:'gym',actor_member_user_id:'member'});
    expect(response.json).toHaveBeenCalledWith({streaks:value});
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control','no-store');
    await expect(getMyPersonalStreaks({tenant:{role:'owner'}} as Request,response)).rejects.toMatchObject({statusCode:403});
  });
  it('uses only the authoritative RPC, keeping tenant/member arguments',async()=>{
    db.rpc.mockResolvedValue({data:value,error:null});
    expect(await memberPersonalStreaks('gym','member')).toEqual(value);
    expect(db.rpc).toHaveBeenCalledWith('get_member_personal_streaks_backend',{target_gym_id:'gym',actor_member_user_id:'member'});
  });
  it('never converts an API error into zero',async()=>{
    db.rpc.mockResolvedValue({data:null,error:{code:'XX000',message:'unavailable'}});
    await expect(memberPersonalStreaks('gym','member')).rejects.toThrow();
  });
  it.each([null,{}, {current_streak:5,longest_streak:8}, {...value,weeklyCurrentStreak:null},
    {...value,weeklyCurrentStreak:9}, {...value,dailyCurrentStreak:11}, {...value,dailyBestStreak:-1},
    {...value,weeklyStatus:'needs_review'}, {...value,weeklyBestStreak:1.5}])('rejects malformed/mixed counters %#',async data=>{
    db.rpc.mockResolvedValue({data,error:null});
    await expect(memberPersonalStreaks('gym','member')).rejects.toThrow();
  });
  it('preserves ambiguity independently from confirmed daily data',()=>{
    const ambiguous={...value,weeklyCurrentStreak:null,weeklyBestStreak:null,weeklyStatus:'needs_review' as const};
    expect(memberPersonalStreaksSchema.parse(ambiguous)).toEqual(ambiguous);
    expect(personalStreakLabels(ambiguous)).toEqual({weekly:'No disponible',weeklyBest:'No disponible',daily:'2 días',dailyBest:'10 días'});
  });
  it.each([[0,'0 semanas','0 días'],[1,'1 semana','1 día'],[2,'2 semanas','2 días']])('formats explicit units %i',(n,w,d)=>{
    expect(streakQuantity(n as number,'week')).toBe(w);expect(streakQuantity(n as number,'day')).toBe(d);
  });
  it('no data/errors do not become false zeroes',()=>{
    expect(personalStreakLabels(undefined)).toEqual({weekly:'No disponible',weeklyBest:'No disponible',daily:'No disponible',dailyBest:'No disponible'});
  });
  it('paused evaluation can retain historical counters with an explicit notice',()=>{
    expect(personalStreakLabels({...value,weeklyStatus:'not_evaluable'})).toMatchObject({weekly:'No aplicable actualmente',weeklyBest:'8 semanas'});
  });
});
