import {describe,it,expect,vi,beforeEach} from 'vitest';
import type {Request,Response} from 'express';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import { ClassBookingConditions, economicsLabels } from './helpers/class-economics-render.js';
import { activityStateFixture } from './helpers/activity-state-fixture.js';
const db=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn()}));
vi.mock('../src/config/supabase.js',()=>({supabaseAdmin:db}));
import {listActivities} from '../src/controllers/activity.controller.js';

const future=new Date(Date.now()+86400000).toISOString();
const base={id:'session',gym_id:'gym',extra_class_id:'activity',location_id:'branch',starts_at:future,ends_at:future,status:'scheduled',capacity_override:null,instructor_user_id:null};
let tables:Record<string,any[]>;
beforeEach(()=>{
 tables={extra_classes:[{id:'activity',gym_id:'gym',name:'Boxeo',is_active:true,capacity:5,billing_mode:'included'}],gym_locations:[{id:'branch',gym_id:'gym',name:'Centro',is_active:true}],class_schedules:[base],class_bookings:[],class_waitlists:[],member_payments:[]};
 db.rpc.mockReset();
 db.rpc.mockImplementation(async(name:string,args:any)=>{
  if(name!=='get_class_waitlist_state_backend')throw new Error('Unexpected RPC '+name);
  return {data:activityStateFixture(tables,args),error:null};
 });
 db.from.mockImplementation((table:string)=>{
  let rows=[...(tables[table]??[])];
  let head=false;
  const q:any={select:(_fields:string,options?:{head?:boolean})=>{head=Boolean(options?.head);return q;},order:()=>q,limit:(n:number)=>{rows=rows.slice(0,n);return q;},
   eq:(k:string,v:unknown)=>{rows=rows.filter(r=>r[k]===v);return q;},
   in:(k:string,v:unknown[])=>{rows=rows.filter(r=>v.includes(r[k]));return q;},
   gte:(k:string,v:string)=>{rows=rows.filter(r=>r[k]>=v);return q;},
   lte:(k:string,v:string)=>{rows=rows.filter(r=>r[k]<=v);return q;},
   then:(resolve:any)=>Promise.resolve({data:head?null:rows,count:head?rows.length:null,error:null}).then(resolve)};
  return q;
 });
});
async function list(query:object={}) {
 const response={json:vi.fn()};
 await listActivities({query,tenant:{role:'member',gymId:'gym',gymUserId:'member'}} as unknown as Request,response as unknown as Response);
 return response.json.mock.calls[0]![0];
}
describe('session reference contract',()=>{
 it('keeps active classes and tenant/location filters',async()=>{
  tables.class_schedules.push({...base,id:'foreign',gym_id:'other'});
  expect((await list()).schedules.map((s:any)=>s.id)).toEqual(['session']);
  expect((await list()).schedules[0].referenceState).toBe('active');
  expect((await list({locationId:'00000000-0000-4000-8000-000000000001'})).schedules).toEqual([]);
 });
 it.each(['extra_classes','gym_locations'])('preserves booked inactive context: %s',async(table)=>{
  tables[table][0].is_active=false;
  tables.class_bookings=[{id:'booking',gym_id:'gym',class_schedule_id:'session',member_user_id:'member',status:'reserved'}];
  const result=await list();
  expect(result.schedules[0].activity.name).toBe('Boxeo');
  expect(result.schedules[0].location.name).toBe('Centro');
  expect(result.schedules[0].myBooking.id).toBe('booking');
  expect(result.schedules[0].referenceState).not.toBe('active');
 });
 it.each(['extra_classes','gym_locations'])('does not promote inactive sessions without relationship: %s',async(table)=>{
  tables[table][0].is_active=false;
  expect((await list()).schedules).toEqual([]);
 });
 it('keeps waitlisted sessions and past booked sessions',async()=>{
  tables.extra_classes[0].is_active=false;
  tables.class_waitlists=[{id:'wait',gym_id:'gym',class_schedule_id:'session',member_user_id:'member',status:'waiting'}];
  expect((await list()).schedules[0].myWaitlist.id).toBe('wait');
  tables.class_schedules[0]={...base,starts_at:new Date(Date.now()-86400000).toISOString(),status:'completed'};
  expect((await list()).schedules[0].status).toBe('completed');
 });
 it('marks missing references without inventing names',async()=>{
  tables.extra_classes=[];
  tables.class_bookings=[{id:'booking',gym_id:'gym',class_schedule_id:'session',member_user_id:'member',status:'reserved'}];
  expect((await list()).schedules[0]).toMatchObject({activity:null,referenceState:'missing'});
 });
});

// Render the actual page components, without mocking their implementations.
const requireFrontend=createRequire(new URL('../../frontend/package.json',import.meta.url));
const React=requireFrontend('react');
const {renderToStaticMarkup}=requireFrontend('react-dom/server');
const {MemoryRouter,Link}=requireFrontend('react-router-dom');
const icons=requireFrontend('lucide-react');
const page=readFileSync(new URL('../../frontend/src/pages/MemberPortalPage.tsx',import.meta.url),'utf8');
const components=page.slice(page.indexOf('function classReferenceIssue'),page.indexOf('function ProgressView'));
const compiled=ts.transpileModule(components+'\nexports.cards={ClassCard,ClassSummary};',{compilerOptions:{jsx:ts.JsxEmit.React,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
const output:any={};
new Function('exports','React','Link','Clock3','UserRound','UsersRound','ChevronRight','money','ClassBookingConditions','classPaymentLabel',compiled)(output,React,Link,icons.Clock3,icons.UserRound,icons.UsersRound,icons.ChevronRight,(n:number)=>String(n),ClassBookingConditions,economicsLabels.classPaymentLabel);
describe('Home and Classes rendering',()=>{
 it('shows the same zero availability in Home and Classes and offers the existing waitlist action',()=>{
  const schedule:any={...base,activity:{name:'Boxeo',is_active:true,billing_mode:'included'},location:{name:'Centro',is_active:true},available:0,occupied:5,capacity:5,isFull:true};
  const render=(Component:any)=>renderToStaticMarkup(React.createElement(MemoryRouter,null,React.createElement(Component,{schedule,membership:{id:'membership'}})));
  for(const Component of Object.values(output.cards) as any[]){
   expect(render(Component).replace(/<[^>]*>/g,'')).toContain('0 de 5 cupos disponibles');
  }
  expect(render(output.cards.ClassCard)).toContain('Unirme a lista de espera');
 });
 it.each(['activity','location'])('keeps an existing reservation visible when %s is inactive',field=>{
  const schedule:any={...base,activity:{name:'Boxeo',is_active:true},location:{name:'Centro',is_active:true},myBooking:{id:'booking',status:'reserved',payment_state:'confirmed',payment_id:'payment'}};
  schedule[field].is_active=false;
  const html=renderToStaticMarkup(React.createElement(MemoryRouter,null,React.createElement(output.cards.ClassCard,{schedule})));
  expect(html).toContain('Boxeo');
  expect(html).toContain('Centro');
  expect(html).toContain('Confirmada');
  expect(html).toContain('Confirmado');
  expect(html).toContain('Cancela en recepción');
  expect(html).not.toContain('>Reservar<');
 });
 it.each(['active','activity_inactive','location_inactive','both_inactive','missing_activity','missing_location'])('renders %s safely',state=>{
  const schedule:any={...base,activity:{name:'Boxeo',is_active:!state.includes('activity_inactive')&&state!=='both_inactive',billing_mode:'included'},location:{name:'Centro',is_active:state!=='location_inactive'&&state!=='both_inactive'},available:4,capacity:5};
  if(state==='missing_activity')schedule.activity=null;
  if(state==='missing_location')schedule.location=null;
  for(const Component of Object.values(output.cards) as any[]){
   const html=renderToStaticMarkup(React.createElement(MemoryRouter,null,React.createElement(Component,{schedule,membership:{id:'membership'}})));
   expect(html).not.toContain('undefined');
   if(state!=='active') expect(html).not.toContain('>Reservar<');
   else expect(html).toContain('Boxeo');
  }
 });
});
