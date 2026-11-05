import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { watchBranchStatus, statusDeadline, type BranchOpenStatus } from '../../frontend/src/utils/branchOpenStatus';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../src/config/supabase.js', () => ({ supabaseAdmin: { rpc } }));
vi.mock('../src/services/audit.service.js', () => ({ writeAuditLog: vi.fn() }));
import { getBranchOpenStatus } from '../src/controllers/calendar.controller';
const status = (offset = 5000): BranchOpenStatus => ({ isOpenNow: false, nextState:'open', nextTransitionAt:new Date(Date.now()+offset).toISOString(), revalidateAt:new Date(Date.now()+offset).toISOString(),validUntil:new Date(Date.now()+86400000).toISOString(),evaluatedAt:new Date().toISOString(),timezone:'America/Guayaquil' });
beforeEach(() => { vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-06T12:00Z'));vi.stubGlobal('window',new EventTarget());vi.stubGlobal('document',Object.assign(new EventTarget(),{visibilityState:'visible'}));rpc.mockReset(); });
afterEach(() => { vi.useRealTimers();vi.unstubAllGlobals(); });
it.each([true,false])('endpoint preserves SQL state %s and ignores caller gym/clock',async isOpenNow => {
 const data={...status(),isOpenNow};rpc.mockResolvedValue({data,error:null});
 const request:any={tenant:{role:'member',gymId:'tenant',gymUserId:'actor'},query:{locationId:'11111111-1111-4111-8111-111111111111',gym_id:'evil',requested_at:'2099-01-01'}};
 const response:any={json:vi.fn(),setHeader:vi.fn()};await getBranchOpenStatus(request,response);
 expect(rpc).toHaveBeenCalledWith('get_member_branch_open_status_backend',{target_gym_id:'tenant',actor_member_user_id:'actor',target_location_id:request.query.locationId});expect(response.json).toHaveBeenCalledWith(data);
});
it('RPC errors propagate instead of returning closed',async()=>{rpc.mockResolvedValue({data:null,error:{message:'failure',code:'XX000'}});await expect(getBranchOpenStatus({tenant:{role:'member'},query:{locationId:'11111111-1111-4111-8111-111111111111'}} as any,{} as any)).rejects.toThrow();});
it('rejects nonmember and invalid location before RPC',async()=>{await expect(getBranchOpenStatus({tenant:{role:'owner'},query:{}} as any,{} as any)).rejects.toThrow();await expect(getBranchOpenStatus({tenant:{role:'member'},query:{locationId:'bad'}} as any,{} as any)).rejects.toThrow();expect(rpc).not.toHaveBeenCalled();});
it.each(['open','closed'])('one transition %s refetches once, never polls',state=>{const refresh=vi.fn();const stop=watchBranchStatus({...status(),nextState:state as any},refresh);vi.advanceTimersByTime(4999);expect(refresh).not.toHaveBeenCalled();vi.advanceTimersByTime(1);expect(refresh).toHaveBeenCalledTimes(1);vi.advanceTimersByTime(86400000);expect(refresh).toHaveBeenCalledTimes(1);stop();});
it('null transition uses horizon and validUntil cap',()=>{const s={...status(),nextTransitionAt:null};expect(statusDeadline(s)).toBe(Date.now()+5000);const refresh=vi.fn();const stop=watchBranchStatus(s,refresh);vi.advanceTimersByTime(5000);expect(refresh).toHaveBeenCalledOnce();stop();});
it.each(['focus','visibilitychange'])('recovers missed transition on %s',event=>{const refresh=vi.fn();const stop=watchBranchStatus(status(),refresh);vi.setSystemTime(Date.now()+10000);(event==='focus'?window:document).dispatchEvent(new Event(event));expect(refresh).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);stop();});
it('cleanup and branch replacement remove timer and listeners',()=>{const old=vi.fn(),current=vi.fn();const stop=watchBranchStatus(status(),old);stop();const end=watchBranchStatus(status(10000),current);vi.advanceTimersByTime(5000);expect(old).not.toHaveBeenCalled();expect(current).not.toHaveBeenCalled();end();window.dispatchEvent(new Event('focus'));expect(current).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);});
it('paired visibility/focus deduplicate; errors can recover on focus',()=>{const refresh=vi.fn();const stop=watchBranchStatus(undefined,refresh);document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));expect(refresh).toHaveBeenCalledOnce();stop();});
it.each(['America/Guayaquil','America/New_York','Africa/Casablanca','Europe/Madrid'])('scheduler ignores browser civil timezone %s',timezone=>{
 const s={...status(),timezone};const refresh=vi.fn();
 const intl=vi.spyOn(Intl,'DateTimeFormat').mockImplementation(()=>{throw new Error('Civil conversion forbidden');});
 try { const stop=watchBranchStatus(s,refresh);vi.advanceTimersByTime(5000);expect(refresh).toHaveBeenCalledOnce();stop(); } finally { intl.mockRestore(); }
});
