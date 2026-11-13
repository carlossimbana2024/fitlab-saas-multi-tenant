import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { weightGoalMetric, computeGoalProgress } from '../src/services/memberWeightGoal.service.js';
import { monthlyWeightGoalProgress } from '../src/services/communityRanking.service.js';
const db = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('../src/config/supabase.js', () => ({ supabaseAdmin: db }));
vi.mock('../src/services/memberProfile.service.js', () => ({ signAvatarUrl: vi.fn(async () => null) }));
import { getMyProgress } from '../src/controllers/member.controller.js';
import { getMemberSocialProfile } from '../src/controllers/memberSocialProfile.controller.js';
import { listMemberCommunity } from '../src/controllers/memberCommunity.controller.js';
import { communityPageSchema, parseAggregate } from '../src/services/memberAggregates.service.js';

const gym='00000000-0000-4000-8000-000000000001', actor='00000000-0000-4000-8000-000000000002', target='00000000-0000-4000-8000-000000000003';
const request=(params={})=>({params,query:{},tenant:{gymId:gym,gymUserId:actor,role:'member',timezone:'America/Guayaquil'}}) as unknown as Request;
const response=()=>({json:vi.fn(),setHeader:vi.fn()}) as unknown as Response;
const body=(res:Response)=>(res.json as ReturnType<typeof vi.fn>).mock.calls[0]![0];
let fitness:any, weights:any[], queries:any[], weightError:any;
const summary={today:'2026-11-03',currentWeekStart:'2026-11-02',currentMonthStart:'2026-11-01',
 totalAttendances:201,currentMonthAttendances:0,currentWeekAttendances:0,latestAttendanceDate:null,hasAttendanceToday:false,
 attendanceByMonth:[],attendanceByWeek:[],averageWeeklyAttendances:0};
beforeEach(()=>{
 vi.clearAllMocks();queries=[];weightError=null;
 fitness={goal_type:'lose_weight',weight_kg:85,target_weight_kg:80,show_weight_progress:true,show_goal:true,show_in_community:true};
 weights=[{id:'a',weight_kg:90,measured_on:'2026-10-01',source:'onboarding'},{id:'b',weight_kg:85,measured_on:'2026-11-01',source:'member'}];
 db.rpc.mockImplementation(async (name:string)=>({data:name==='get_member_personal_streaks_backend'
   ? {today:summary.today,weeklyCurrentStreak:0,weeklyBestStreak:0,weeklyStatus:'available',dailyCurrentStreak:0,dailyBestStreak:0}
   : summary,error:null}));
 db.from.mockImplementation((table:string)=>{
   let ascending=true,limit:number|undefined;
   const result=()=>{
     const sorted=[...weights].sort((a,b)=>a.measured_on.localeCompare(b.measured_on));
     const data=table==='member_weight_entries'?(ascending?sorted:sorted.reverse()).slice(0,limit):
       table==='member_fitness_profiles'?fitness:table==='gym_users'?{id:target,profiles:{full_name:'Miembro'}}:null;
     return {data,error:table==='member_weight_entries'?weightError:null,count:0};
   };
   const q:any={table,select:vi.fn(()=>q),eq:vi.fn(()=>q),gte:vi.fn(()=>q),lte:vi.fn(()=>q),
     order:vi.fn((_key:string,options:any)=>{ascending=options.ascending;return q;}),
     limit:vi.fn((n:number)=>{limit=n;return q;}),
     maybeSingle:vi.fn(()=>{const r=result();return Promise.resolve({...r,data:Array.isArray(r.data)?r.data[0]??null:r.data});}),
     then:(resolve:any,reject:any)=>Promise.resolve(result()).then(resolve,reject)};
   queries.push(q);return q;
 });
});

describe('FIT-MEMBER-011 historical endpoints independent of visual window',()=>{
 it.each([0,1,3,501,1201])('%i measurements preserve exact endpoints',async count=>{
  weights=Array.from({length:count},(_,i)=>({id:String(i),weight_kg:i===0?90:i===count-1?84:85,
   measured_on:new Date(Date.UTC(2022,0,i+1)).toISOString().slice(0,10),source:'member'}));
  const res=response();await getMyProgress(request(),res);const p=body(res).progress;
  expect(p.initialWeightKg).toBe(count?90:null);
  expect(p.currentWeightKg).toBe(count===0?null:count===1?90:84);
  expect(p.weights).toHaveLength(Math.min(count,500));
  if(count>1){expect(p.weights.at(-1).weightKg).toBe(84);expect(p.goal.progressPercent).toBe(60);}
  if(count>500)expect(p.weights[0].weightKg).toBe(85);
  const qs=queries.filter(q=>q.table==='member_weight_entries');
  expect(qs).toHaveLength(3);
  expect(qs.map(q=>q.limit.mock.calls[0][0])).toEqual([500,1,1]);
  for(const q of qs){expect(q.eq).toHaveBeenCalledWith('gym_id',gym);expect(q.eq).toHaveBeenCalledWith('member_user_id',actor);}
  expect(qs[1].order).toHaveBeenCalledWith('measured_on',{ascending:true});
  expect(qs[2].order).toHaveBeenCalledWith('measured_on',{ascending:false});
 });
 it('backdated insertion changes baseline, recent insertion and replacement update current',async()=>{
  weights.push({id:'older',weight_kg:92,measured_on:'2026-01-01',created_at:'2026-11-02'});
  let res=response();await getMyProgress(request(),res);
  expect(body(res).progress).toMatchObject({initialWeightKg:92,currentWeightKg:85});
  weights.push({id:'new',weight_kg:84,measured_on:'2026-11-03'});
  res=response();await getMyProgress(request(),res);
  expect(body(res).progress).toMatchObject({initialWeightKg:92,currentWeightKg:84});
  weights.at(-1).weight_kg=83;
  res=response();await getMyProgress(request(),res);expect(body(res).progress.currentWeightKg).toBe(83);
 });
 it.each(['gain_weight','maintain_weight'])('large history preserves %s',async goal=>{
  fitness.goal_type=goal;fitness.target_weight_kg=70;
  weights=Array.from({length:1201},(_,i)=>({id:String(i),weight_kg:i===0?60:i===1200?65:62,
   measured_on:new Date(Date.UTC(2022,0,i+1)).toISOString().slice(0,10)}));
  const res=response();await getMyProgress(request(),res);
  expect(body(res).progress.goal).toMatchObject({initialWeightKg:60,currentWeightKg:65,
   progressPercent:goal==='gain_weight'?50:null});
  if(goal==='maintain_weight')expect(body(res).progress.goal.maintenance.differenceKg).toBe(-5);
 });
 it.each([true,false])('endpoint read error propagates (ascending=%s)',async ascending=>{
  const original=db.from.getMockImplementation()!;
  db.from.mockImplementation((table:string)=>{
   const q=original(table);
   if(table==='member_weight_entries')q.maybeSingle.mockImplementation(()=>{
    if(q.order.mock.calls[0][1].ascending===ascending)return Promise.resolve({data:null,error:{message:'endpoint unavailable'}});
    return Promise.resolve({data:{weight_kg:90},error:null});
   });
   return q;
  });
  await expect(getMyProgress(request(),response())).rejects.toThrow();
 });
});

describe('FIT-MEMBER-010 canonical metric',()=>{
 it.each([
  ['lose_weight',80,90,85,50],['lose_weight',80,90,80,100],['lose_weight',80,90,75,100],
  ['lose_weight',80,90,95,0],['gain_weight',70,60,65,50],['gain_weight',70,60,58,0],
  ['gain_weight',70,60,75,100],['build_muscle',70,60,65,50],['gain_weight',63,60,61,33.3],
  ['lose_weight',80,90,90,0],['gain_weight',85,85,95,null],['lose_weight',85,85,85,null],
 ] as const)('%s target %s baseline %s current %s = %s',(goal,t,b,c,expected)=>{
  expect(weightGoalMetric(goal,t,b,c).progressPercent).toBe(expected);
 });
 it.each([null,NaN,Infinity,-1,0,501])('rejects invalid/missing current %s',current=>{
  expect(weightGoalMetric('lose_weight',80,90,current)).toEqual({progressPercent:null,maintenance:null});
 });
 it.each([[85,0],[86.2,1.2],[84.2,-0.8],[95,10]])('maintenance at %s has no percent',(current,difference)=>{
  expect(weightGoalMetric('maintain_weight',85,85,current)).toEqual({progressPercent:null,
   maintenance:{currentWeightKg:current,targetWeightKg:85,differenceKg:difference}});
 });
 it('missing baseline/target does not invent progress',()=>{
  expect(computeGoalProgress('lose_weight',null,85,80)).toBeNull();
  expect(computeGoalProgress('lose_weight',90,85,null)).toBeNull();
 });
 it('monthly helper excludes only non-comparable progress and preserves its period',()=>{
  const history=[{weightKg:90,measuredOn:'2026-09-01'},{weightKg:88,measuredOn:'2026-09-30'},{weightKg:85,measuredOn:'2026-10-31'}];
  expect(monthlyWeightGoalProgress('lose_weight',80,history,'2026-10-01','2026-10-31')?.progressPercent).toBe(37.5);
  expect(monthlyWeightGoalProgress('maintain_weight',85,history,'2026-10-01','2026-10-31')).toBeNull();
 });
});

describe('FIT-MEMBER-010 consumers, history and privacy',()=>{
 it('Progreso and social profile ignore survey edits and use the same history',async()=>{
  for(const surveyWeight of [85,82,95]){
   fitness.weight_kg=surveyWeight;
   const p=response(),social=response();
   await getMyProgress(request(),p);await getMemberSocialProfile(request({memberId:target}),social);
   expect(body(p).progress.goal).toMatchObject({initialWeightKg:90,currentWeightKg:85,progressPercent:50});
   expect(body(social).profile.progressPercent).toBe(50);
   expect(queries.filter(q=>q.table==='member_weight_entries').some(q=>q.limit.mock.calls.some(([n]:number[])=>n===500))).toBe(true);
  }
  for(const q of queries.filter(q=>q.table==='member_weight_entries'))expect(q.eq).toHaveBeenCalledWith('gym_id',gym);
 });
 it('no history gives no metric even if survey equals target',async()=>{
  weights=[];fitness.weight_kg=80;
  const p=response(),s=response();await getMyProgress(request(),p);await getMemberSocialProfile(request({memberId:target}),s);
  expect(body(p).progress.goal).toBeNull();expect(body(s).profile.progressPercent).toBeNull();expect(body(s).profile.weightMaintenance).toBeNull();
 });
 it.each([[85,0],[86.2,1.2],[84.2,-0.8]])('personal/social maintenance %s without percentage',async(current,difference)=>{
  fitness.goal_type='maintain_weight';fitness.target_weight_kg=85;weights[1].weight_kg=current;
  const p=response(),s=response();await getMyProgress(request(),p);await getMemberSocialProfile(request({memberId:target}),s);
  expect(body(p).progress.goal.progressPercent).toBeNull();
  expect(body(p).progress.goal.maintenance.differenceKg).toBe(difference);
  expect(body(s).profile.weightMaintenance).toEqual(body(p).progress.goal.maintenance);
  expect(body(s).profile.progressPercent).toBeNull();
 });
 it('social maintenance requires both consents, own profile can see it',async()=>{
  fitness.goal_type='maintain_weight';fitness.target_weight_kg=85;
  fitness.show_goal=false;
  const hidden=response();await getMemberSocialProfile(request({memberId:target}),hidden);
  expect(body(hidden).profile.weightMaintenance).toBeNull();
  const own=response();await getMemberSocialProfile(request(),own);expect(body(own).profile.weightMaintenance).not.toBeNull();
  fitness.show_goal=true;fitness.show_weight_progress=false;queries=[];
  const noWeight=response();await getMemberSocialProfile(request({memberId:target}),noWeight);
  expect(body(noWeight).profile.weightMaintenance).toBeNull();
  expect(queries.some(q=>q.table==='member_weight_entries')).toBe(false);
 });
 it('weight API failure is not an empty history',async()=>{
  weightError={message:'unavailable'};
  await expect(getMyProgress(request(),response())).rejects.toThrow();
  await expect(getMemberSocialProfile(request({memberId:target}),response())).rejects.toThrow();
 });
 it.each(['lose_weight','gain_weight','maintain_weight'])('Community forwards SQL metric, never recomputes %s',async goal=>{
  const metric=weightGoalMetric(goal,goal==='gain_weight'?70:80,goal==='gain_weight'?60:90,goal==='gain_weight'?65:85);
  const item={id:target,name:'Miembro',avatarPath:null,goalType:goal,publicMessage:null,joinedAt:null,weeklyStreak:null,monthlyAttendances:null,progressPercent:metric.progressPercent,weightMaintenance:metric.maintenance,reactions:{like:0,love:0,mine:null}};
  db.rpc.mockResolvedValue({data:{items:[item],nextCursor:null,hasMore:false},error:null});
  const res=response();await listMemberCommunity(request(),res);
  expect(body(res).items[0]).toMatchObject({progressPercent:metric.progressPercent,weightMaintenance:metric.maintenance});
  expect(db.from).not.toHaveBeenCalled();
 });
 it('malformed maintenance payload remains an API error',()=>{
  expect(()=>parseAggregate(communityPageSchema,{items:[{weightMaintenance:{differenceKg:NaN}}],hasMore:false,nextCursor:null})).toThrow();
 });
});
