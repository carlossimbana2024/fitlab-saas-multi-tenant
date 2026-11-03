import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
const db = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../src/config/supabase.js', () => ({ supabaseAdmin: db }));
vi.mock('../src/services/memberProfile.service.js', () => ({ signAvatarUrl: vi.fn(async (path: string) => `signed:${path}`) }));
import { getMyProgress } from '../src/controllers/member.controller.js';
import { listMemberCommunity } from '../src/controllers/memberCommunity.controller.js';
import { getMemberCommunityRankings } from '../src/controllers/memberCommunityRanking.controller.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const request = (query = {}) => ({ query, tenant: { gymId: id(900), gymUserId: id(901), role: 'member', timezone: 'America/Guayaquil' } }) as unknown as Request;
const response = () => ({ json: vi.fn() }) as unknown as Response;
const summary = (total: number) => ({ today:'2026-11-02',currentWeekStart:'2026-11-02',currentMonthStart:'2026-11-01',
  totalAttendances:total,currentMonthAttendances:2,currentWeekAttendances:1,latestAttendanceDate:'2026-11-02',hasAttendanceToday:true,
  attendanceByMonth:[{period:'2026-11',count:2}],attendanceByWeek:[{period:'2026-11-02',count:1}],averageWeeklyAttendances:0.1 });
const member = (n: number) => ({ id:id(n),name:`Member ${n}`,avatarPath:null,goalType:null,publicMessage:null,joinedAt:null,
  currentStreak:null,longestStreak:null,monthlyAttendances:null,progressPercent:null,reactions:{like:0,love:0,mine:null} });
beforeEach(() => {
  vi.clearAllMocks();
  db.from.mockImplementation(() => { const q: any = { data:null,error:null }; for(const method of ['select','eq','order','limit','maybeSingle']) q[method]=vi.fn(()=>q); return q; });
});
describe('FIT-MEMBER-008 consumer boundaries', () => {
  it.each([201,2001,12003])('progress preserves SQL total %i independently of history',async total=>{
    db.rpc.mockResolvedValue({data:summary(total),error:null}); const res=response();
    await getMyProgress(request(),res);
    expect(res.json).toHaveBeenCalledWith({progress:expect.objectContaining({totalAttendances:total,hasAttendanceToday:true,currentMonthAttendances:2})});
    expect(db.from).not.toHaveBeenCalledWith('attendances');
    expect(db.rpc).toHaveBeenCalledWith('get_member_attendance_summary_backend',{target_gym_id:id(900),actor_member_user_id:id(901)});
    const weightQuery = db.from.mock.results[1]!.value;
    expect(weightQuery.limit).toHaveBeenCalledWith(500); // FIT-MEMBER-011 intentionally unchanged.
  });
  it('walks 360 RPC members by cursor without fetching gym-wide tables',async()=>{
    db.from.mockImplementation(()=>{throw Error('Unexpected broad query');});
    db.rpc.mockImplementation(async (_name,args)=>{const start=args.after_cursor?.start??0;return {error:null,data:{
      items:Array.from({length:Math.min(20,360-start)},(_,i)=>member(start+i+1)),
      nextCursor:start+20<360?{start:start+20}:null,hasMore:start+20<360,
    }};});
    const ids:string[]=[];let cursor:any=null;
    do { const res=response();await listMemberCommunity(request(cursor?{cursor:JSON.stringify(cursor)}:{}),res);
      const page=(res.json as any).mock.calls[0][0];ids.push(...page.items.map((m:any)=>m.id));cursor=page.nextCursor;
    } while(cursor);
    expect(ids).toHaveLength(360);expect(new Set(ids).size).toBe(360);expect(db.rpc).toHaveBeenCalledTimes(18);
    expect(db.from).not.toHaveBeenCalled();
  });
  it.each(['all','similar_goal','consistent','new','longest_streak','featured','progress'])('forwards %s before SQL pagination and ignores forged tenant IDs',async filter=>{
    db.rpc.mockResolvedValue({data:{items:[],nextCursor:null,hasMore:false},error:null});
    await listMemberCommunity(request({filter,gymId:'other',memberId:'other'}),response());
    expect(db.rpc).toHaveBeenCalledWith('list_member_community_page_backend',{
      target_gym_id:id(900),actor_member_user_id:id(901),requested_filter:filter,page_size:20,after_cursor:null,
    });
  });
  it('preserves SQL ranking winner outside old 250 boundary and all categories',async()=>{
    const entry={memberUserId:id(360),name:'Winner 360',value:31,position:1,avatarPath:null,goalType:null};
    db.rpc.mockResolvedValue({data:{from:'2020-01-01',to:'2020-01-31',categories:{attendance:[entry],streak:[entry],progress:[]}},error:null});
    const res=response();await getMemberCommunityRankings(request({month:'2020-01'}),res);
    const ranking=(res.json as any).mock.calls[0][0].ranking;
    expect(ranking.categories.attendance.entries[0]).toMatchObject(entryWithoutPath(entry));
    expect(ranking.categories.progress.entries).toEqual([]);
    expect(db.from).not.toHaveBeenCalled();
    expect(db.rpc).toHaveBeenCalledWith('get_member_community_rankings_backend',{
      target_gym_id:id(900),actor_member_user_id:id(901),requested_month:'2020-01-01',
    });
  });
  it.each([getMyProgress,listMemberCommunity,getMemberCommunityRankings])('RPC failures and null results never become zeros/empty lists',async controller=>{
    db.rpc.mockResolvedValue({data:null,error:{message:'Unavailable',code:'XX000'}});
    await expect(controller(request(),response())).rejects.toBeDefined();
    db.rpc.mockResolvedValue({data:null,error:null});
    await expect(controller(request(),response())).rejects.toMatchObject({statusCode:502});
  });
  it.each([{pageSize:51},{pageSize:0},{cursor:'bad'},{cursor:'[]'},{filter:'unknown'}])('rejects malformed page %j',async query=>{
    await expect(listMemberCommunity(request(query),response())).rejects.toMatchObject({statusCode:400});
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
function entryWithoutPath({avatarPath:_,...entry}:any){return entry;}
