import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Request,Response} from 'express';
const db=vi.hoisted(()=>({from:vi.fn()}));
vi.mock('../src/config/supabase.js',()=>({supabaseAdmin:db}));
import {listActivities} from '../src/controllers/activity.controller.js';
let bookings:any[], capacity:number, override:number|null, inactive:boolean, countFailure:boolean, missingCount:boolean;
let countQueries:Array<{fields:string;options:any;filters:any[]}>;
beforeEach(()=>{
 bookings=[];capacity=10;override=null;inactive=false;countFailure=false;missingCount=false;countQueries=[];
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
   // Simulate a small PostgREST row cap. HEAD exact count must remain unaffected.
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
  expect(countQueries[0]).toMatchObject({fields:'id',options:{count:'exact',head:true}});
  expect(countQueries[0].filters).not.toContainEqual(['member_user_id','me']);
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
 it.each(['failure','missing'])('does not turn count %s into zero',async(mode)=>{
  countFailure=mode==='failure';missingCount=mode==='missing';
  await expect(list()).rejects.toThrow();
 });
});
