import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Request,Response} from 'express';
import { activityStateFixture } from './helpers/activity-state-fixture.js';
const db=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn()}));
vi.mock('../src/config/supabase.js',()=>({supabaseAdmin:db}));
import {listActivities} from '../src/controllers/activity.controller.js';
let bookings:any[], capacity:number, override:number|null, inactive:boolean, countFailure:boolean, missingCount:boolean;
let countQueries:Array<{fields:string;options:any;filters:any[]}>;
let statePatch:any;
beforeEach(()=>{
 bookings=[];capacity=10;override=null;inactive=false;countFailure=false;missingCount=false;countQueries=[];statePatch=null;
 db.rpc.mockReset();
 db.rpc.mockImplementation(async(name:string,args:any)=>{
  if(name!=='get_class_waitlist_state_backend')throw new Error('Unexpected RPC '+name);
  if(countFailure)return {data:null,error:{message:'Database unavailable'}};
  const data=activityStateFixture({
   extra_classes:[{id:'activity',gym_id:'gym',capacity}],
   class_schedules:[{id:'session',gym_id:'gym',extra_class_id:'activity',capacity_override:override}],
   class_bookings:bookings,
  },args);
  if(missingCount)delete (data.sessions[0] as any).occupied;
  if(statePatch)Object.assign(data.sessions[0]!,statePatch);
  return {data,error:null};
 });
 db.from.mockImplementation((table:string)=>{
  const fixtures:any={
   extra_classes:[{id:'activity',gym_id:'gym',name:'Boxeo',capacity,is_active:!inactive,billing_mode:'included'}],
   gym_locations:[{id:'branch',gym_id:'gym',name:'Centro',is_active:true}],
   class_schedules:[{id:'session',gym_id:'gym',extra_class_id:'activity',location_id:'branch',starts_at:new Date(Date.now()+86400000).toISOString(),status:'scheduled',capacity_override:override}],
   class_bookings:bookings,
  };
  let rows=[...(fixtures[table]??[])],head=false;
  const query={fields:'',options:null as any,filters:[] as any[]};
  const q:any={select:(fields:string,options:any)=>{head=Boolean(options?.head);Object.assign(query,{fields,options});if(head)countQueries.push(query);return q;},
   eq:(key:string,value:any)=>{query.filters.push([key,value]);rows=rows.filter(r=>r[key]===value);return q;},
   in:(key:string,values:any[])=>{query.filters.push([key,values]);rows=rows.filter(r=>values.includes(r[key]));return q;},
   order:()=>q,gte:()=>q,lte:()=>q,limit:()=>q,
   // Simulate a small PostgREST row cap. SQL aggregates remain independent.
   then:(resolve:any)=>Promise.resolve(head
    ? {data:null,count:missingCount?null:rows.length,error:countFailure?{message:'Database unavailable'}:null}
    : {data:rows.slice(0,100),error:null}).then(resolve)};
  return q;
 });
});
function booking(id:string,status='reserved',member='other-'+id,gym='gym',session='session'){
 return {id,member_user_id:member,gym_id:gym,class_schedule_id:session,status,private_name:'PRIVATE-'+id};
}
async function list(){
 const response={json:vi.fn()};
 await listActivities({query:{},tenant:{gymId:'gym',gymUserId:'me',role:'member'}} as unknown as Request,response as unknown as Response);
 return response.json.mock.calls[0]![0];
}
describe('FIT-MEMBER-003 exact global occupancy',()=>{
 it('A: empty class has all ten places available',async()=>{
  expect((await list()).schedules[0]).toMatchObject({capacity:10,occupied:0,available:10,isFull:false,myBooking:null});
 });
 it('B/E: full class includes others only in aggregates, never participant data',async()=>{
  capacity=2;bookings=[booking('secret-A'),booking('secret-B')];
  const response=await list();
  expect(response.schedules[0]).toMatchObject({occupied:2,available:0,isFull:true,myBooking:null});
  expect(response.bookings).toEqual([]);
  expect(JSON.stringify(response)).not.toMatch(/secret-A|secret-B|PRIVATE/);
  expect(db.rpc).toHaveBeenCalledWith('get_class_waitlist_state_backend',{
   target_gym_id:'gym',target_actor_gym_user_id:'me',target_schedule_ids:['session'],
  });
  expect(countQueries).toEqual([]); // No client-side participant scan for counts.
 });
 it('C/F: counts four including self, while preserving own booking',async()=>{
  bookings=[booking('own','reserved','me'),booking('b'),booking('c'),booking('d')];
  expect((await list()).schedules[0]).toMatchObject({occupied:4,available:6,isFull:false,myBooking:{id:'own'}});
 });
 it('D: only reserved and attended occupy places, regardless of payment',async()=>{
  bookings=[booking('a'),booking('b','attended'),booking('c','cancelled'),booking('d','no_show')];
  expect((await list()).schedules[0]).toMatchObject({occupied:2,available:8});
 });
 it('clamps availability at zero and respects session capacity override',async()=>{
  override=1;bookings=[booking('a'),booking('b')];
  expect((await list()).schedules[0]).toMatchObject({capacity:1,occupied:2,available:0,isFull:true});
 });
 it('G: free places do not reactivate an inactive session',async()=>{
  inactive=true;bookings=[booking('own','reserved','me')];
  expect((await list()).schedules[0]).toMatchObject({available:9,referenceState:'activity_inactive',activity:{is_active:false}});
 });
 it('H: excludes other gyms and other sessions',async()=>{
  bookings=[booking('a'),booking('foreign','reserved','other','different-gym'),booking('different-session','reserved','other','gym','elsewhere')];
  expect((await list()).schedules[0]).toMatchObject({occupied:1,available:9});
 });
 it('counts beyond returned-row limits',async()=>{
  capacity=2000;bookings=Array.from({length:1501},(_,i)=>booking(String(i)));
  expect((await list()).schedules[0]).toMatchObject({occupied:1501,available:499,isFull:false});
 });
 it('uses SQL-held offers, not capacity minus returned participant rows',async()=>{
  statePatch={occupied:4,offered_count:6,available:0};
  expect((await list()).schedules[0]).toMatchObject({occupied:4,offeredCount:6,available:0,isFull:true});
 });
 it('passes through SQL position instead of calculating a rank from visible members',async()=>{
  const own={id:'queue',member_user_id:'me',status:'waiting',state:'waiting',position:7,
   joined_at:'2026-10-26T12:00:00Z',offer_id:null,offered_at:null,expires_at:null};
  statePatch={waitlist:[own],myWaitlist:own};
  const result=await list();
  expect(result.schedules[0].myWaitlist.position).toBe(7);
  expect(result.waitlists[0].position).toBe(7);
 });
 it.each(['missing-session','duplicate-session','invalid-offer'])('rejects malformed state: %s',async mode=>{
  if(mode==='missing-session')db.rpc.mockResolvedValue({data:{server_time:new Date().toISOString(),offers_enabled:false,sessions:[]},error:null});
  else if(mode==='duplicate-session')db.rpc.mockImplementation(async(_name:string,args:any)=>{
   const data=activityStateFixture({class_schedules:[{id:'session',gym_id:'gym',extra_class_id:'a'}]},args);
   data.sessions.push(data.sessions[0]!);return {data,error:null};
  });
  else statePatch={myWaitlist:{id:'q',member_user_id:'me',status:'offered',state:'offered',position:1,
   joined_at:'2026-10-26T12:00:00Z',offer_id:null,offered_at:null,expires_at:null}};
  await expect(list()).rejects.toMatchObject({statusCode:503,code:'CLASS_OCCUPANCY_UNAVAILABLE'});
 });
 it.each(['failure','missing'])('does not turn count %s into zero',async(mode)=>{
  countFailure=mode==='failure';missingCount=mode==='missing';
  await expect(list()).rejects.toThrow();
 });
});
