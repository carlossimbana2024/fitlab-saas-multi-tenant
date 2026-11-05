import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const req=createRequire(new URL('../../frontend/package.json',import.meta.url));
const React=req('react');const {act,create}=req('react-test-renderer');
const {QueryClient,QueryClientProvider}=req('@tanstack/react-query');
const api={get:vi.fn(),post:vi.fn()};
let session:any;
const noop=()=>null;
const emptyModules=new Proxy({}, {get:()=>noop});
function load(file:string){
 const exports:any={};const source=readFileSync(new URL(`../../frontend/src/${file}`,import.meta.url),'utf8');
 new Function('exports','require','React',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText)(exports,(id:string)=>{
   if(id.endsWith('.css'))return {};
   if(id.includes('/services/api'))return {api,apiErrorMessage:()=> 'API_FAILED'};
   if(id.includes('/context/AuthContext'))return {useAuth:()=>({session,refresh:vi.fn()})};
   if(['membershipCoverage','currentPortalDate','currentWeeklyProgress','portalTime','classScheduleHours'].some(name=>id===`../utils/${name}`||id===`./${name}`))return load(`utils/${id.split('/').at(-1)}.ts`);
   if(id.includes('/components/AttendanceQrCard'))return {AttendanceQrCard:({hasAttendanceToday}:any)=>React.createElement('div',{'data-attended-today':hasAttendanceToday})};
   if(id==='react-router-dom')return {Link:({children}:any)=>React.createElement('a',null,children)};
   if(id==='lucide-react'||id.startsWith('../components/')||id.startsWith('../utils/'))return emptyModules;
   return req(id);
 },React);return exports;
}
const {MemberPortalPage}=load('pages/MemberPortalPage.tsx');const {MemberCommunityPage}=load('pages/MemberCommunityPage.tsx');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const trees:any[]=[];const clients:any[]=[];
const flush=async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,30));});};
async function mount(component:any,props={}){
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0},mutations:{retry:false}}});clients.push(client);
 let tree:any;await act(async()=>{tree=create(React.createElement(QueryClientProvider,{client},React.createElement(component,props)));});trees.push(tree);
 await flush();await flush();return {tree,client};
}
const text=(tree:any)=>JSON.stringify(tree.toJSON());
const button=(tree:any,label:string)=>tree.root.findAllByType('button').find((b:any)=>b.props.children===label);
async function click(tree:any,label:string){await act(async()=>button(tree,label).props.onClick());await flush();}
const ranking=(month='2026-11')=>({ranking:{period:{key:month,label:month,from:month+'-01',to:month+'-28',isCurrent:false},availablePeriods:[{key:'2026-11',label:'Nov'},{key:'2026-10',label:'Oct'}],historyMode:'reconstructed',categories:Object.fromEntries(['attendance','streak','progress'].map(key=>[key,{title:key,explanation:key,entries:[{position:1,memberUserId:'winner',name:`SQL winner ${month}`,avatarUrl:null,value:123,displayValue:'123 SQL',goalType:null}]}]))}});
beforeEach(()=>{session={gymUser:{id:'viewer',gym_id:'gym-a',profiles:{full_name:'Reader'}}};api.get.mockReset();});
afterEach(async()=>{await act(async()=>trees.splice(0).forEach(t=>t.unmount()));clients.splice(0).forEach(c=>c.clear());vi.useRealTimers();vi.unstubAllGlobals();});

it('FIT-MEMBER-013 tenant and branch changes restart a single timer without leaking the previous date',async()=>{
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-01T00:30:00Z'));
  vi.stubGlobal('document',Object.assign(new EventTarget(),{visibilityState:'visible'}));
  vi.stubGlobal('window',new EventTarget());
  const {useCurrentPortalDate}=load('utils/currentPortalDate.ts');
  function Probe({tz,tenant,branch}:any){return React.createElement('div',null,useCurrentPortalDate(tz,tenant,branch));}
  let tree:any;
  await act(async()=>{tree=create(React.createElement(Probe,{tz:'America/Guayaquil',tenant:'a',branch:'America/New_York'}));});
  trees.push(tree);
  expect(text(tree)).toContain('2026-05-31');
  expect(vi.getTimerCount()).toBe(1);
  await act(async()=>tree.update(React.createElement(Probe,{tz:'Europe/Madrid',tenant:'b',branch:'America/New_York'})));
  expect(text(tree)).toContain('2026-06-01');
  expect(vi.getTimerCount()).toBe(1);
  await act(async()=>tree.update(React.createElement(Probe,{tz:'Europe/Madrid',tenant:'b',branch:'Pacific/Galapagos'})));
  expect(text(tree)).toContain('2026-06-01');
  expect(vi.getTimerCount()).toBe(1);
  await act(async()=>tree.unmount());trees.pop();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['America/Guayaquil','Europe/Madrid'])('FIT-MEMBER-013 membership, calendar and weight use %s independently of branch',async tz=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-06-01T00:30:00Z'));
  session.gymUser.gym={timezone:tz};
  const today=tz==='Europe/Madrid'?'2026-06-01':'2026-05-31';
  api.get.mockImplementation(async(url:string)=>({data:url==='/memberships'?{memberships:[{id:'m',status:'active',price_at_purchase:30,currency:'USD',attendance_mode_snapshot:'daily',
    membership_periods:[{status:'active',starts_on:'2026-01-01',ends_on:'2026-06-02'}]}]}
    :url==='/members/me/progress'?{progress:{today,weights:[],goal:null,currentWeightKg:84,motivation:{tone:'neutral',title:'Summary',message:''},attendanceByMonth:[],attendanceByWeek:[]}}
    :url==='/calendar'?{gym:{timezone:tz},location:{timezone:'America/New_York'},hours:[],exceptions:[]}
    :{fitnessProfile:{id:'profile'},attendances:[],streaks:[],schedules:[],progress:[],announcements:[]}}));
  const {tree}=await mount(MemberPortalPage,{section:'home'});
  expect(text(tree)).toContain(tz==='Europe/Madrid'?'1 días restantes':'2 días restantes');
  await act(async()=>tree.update(React.createElement(QueryClientProvider,{client:clients.at(-1)},React.createElement(MemberPortalPage,{section:'progress'}))));
  await click(tree,'Registrar peso');
  const date=tree.root.findAllByType('input').find((n:any)=>n.props.type==='date');
  expect(date.props.value).toBe(today);expect(date.props.max).toBe(today);
  expect(api.get.mock.calls.find(([u])=>u==='/calendar')[1].params.from).toBe(tz==='Europe/Madrid'?'2026-05-31':'2026-04-30');
});

it('FIT-MEMBER-012 refreshes the daily summary, week, month and upcoming classes without losing a weight draft',async()=>{
  vi.useFakeTimers({toFake:['Date']});
  vi.setSystemTime(new Date('2026-06-01T04:59:00Z'));
  const tab=Object.assign(new EventTarget(),{visibilityState:'visible'});
  const reload=vi.fn();
  vi.stubGlobal('document',tab);
  vi.stubGlobal('window',Object.assign(new EventTarget(),{location:{reload}}));
  const membership={id:'m',status:'active',attendance_mode_snapshot:'weekly',weekly_target_snapshot:3,
    membership_periods:[{status:'active',starts_on:'2026-05-01',ends_on:'2026-06-30'}]};
  const oldWeek={id:'old',membership_id:'m',week_starts_on:'2026-05-25',week_ends_on:'2026-05-31',target_attendances:3,completed_attendances:3,goal_met:true};
  api.get.mockImplementation(async(url:string)=>{
    if(url==='/members/me/progress'){
      const sunday=new Date().getUTCHours()<5;
      return {data:{progress:{today:sunday?'2026-05-31':'2026-06-01',hasAttendanceToday:sunday,totalAttendances:20,
        currentMonthAttendances:sunday?9:0,currentWeekAttendances:sunday?3:0,attendanceByMonth:[],attendanceByWeek:[],weights:[],currentWeightKg:84,goal:null,
        motivation:{tone:'neutral',title:'Summary',message:''}}}};
    }
    return {data:url==='/memberships'?{memberships:[membership]}
      :url==='/attendances/weekly-progress'?{progress:[oldWeek]}
      :url==='/calendar'?{hours:[],exceptions:[],location:{timezone:'America/Guayaquil'}}
      :{attendances:[],streaks:[],schedules:[],announcements:[],fitnessProfile:{id:'profile'}}};
  });
  const {tree,client}=await mount(MemberPortalPage,{section:'progress'});
  const attendance=()=>tree.root.findByProps({'data-attended-today':true});
  const completed=()=>tree.root.findByProps({'aria-label':'Tu objetivo semanal'}).props.value;
  expect(attendance()).toBeDefined();
  expect(completed()).toBe(3);
  await click(tree,'Registrar peso');
  const weightInput=()=>tree.root.findAllByType('input').find((input:any)=>input.props.type==='number');
  await act(async()=>weightInput().props.onChange({target:{value:'83.5'}}));
  vi.setSystemTime(new Date('2026-06-01T05:01:00Z'));
  await act(async()=>{tab.dispatchEvent(new Event('visibilitychange'));});
  await flush();await flush();
  expect(tree.root.findByProps({'data-attended-today':false})).toBeDefined();
  expect(completed()).toBe(0);
  expect(client.getQueryData(['my-progress','gym-a','viewer','2026-06-01','America/Guayaquil'])).toMatchObject({today:'2026-06-01',currentMonthAttendances:0});
  for(const url of ['/members/me/progress','/attendances/weekly-progress','/calendar','/activities']){
    expect(api.get.mock.calls.filter(([path])=>path===url)).toHaveLength(2);
  }
  expect(api.get).toHaveBeenCalledWith('/calendar',{params:{from:'2026-05-31',to:'2026-07-01'}});
  expect(api.get.mock.calls.filter(([path])=>path==='/memberships')).toHaveLength(1);
  expect(weightInput().props.value).toBe('83.5');
  expect(reload).not.toHaveBeenCalled();
});
describe('FIT-MEMBER-008 real React consumers',()=>{
 it.each([201,2001])('Home and Progress display %i while only five historical rows are loaded',async total=>{
   api.get.mockImplementation(async(url:string)=>({data:url==='/members/me/progress'?{progress:{totalAttendances:total,hasAttendanceToday:true,currentMonthAttendances:3,currentWeekAttendances:1,
     attendanceByMonth:[],attendanceByWeek:[],latestAttendanceDate:'2026-11-02',weights:[],goal:null,motivation:{tone:'neutral',title:'Summary',message:''}}}
     :url==='/attendances'?{attendances:Array.from({length:5},(_,i)=>({id:String(i),status:'valid',attendance_date:'2026-11-02'}))}
     :url==='/calendar'?{hours:[],exceptions:[],location:{timezone:'America/Guayaquil'}}
     :url==='/members/me/fitness-profile'?{fitnessProfile:{id:'profile'}}
     :{memberships:[],streaks:[],progress:[],schedules:[],announcements:[]}}));
   const home=await mount(MemberPortalPage,{section:'home'});const progress=await mount(MemberPortalPage,{section:'progress'});
   expect(text(home.tree)).toContain(String(total));expect(text(progress.tree)).toContain(String(total));
   expect(api.get.mock.calls.some(([url])=>url==='/members/me/progress')).toBe(true);
 });
 it('walks >250 members, forwards cursors, resets filters and separates ranking months',async()=>{
   api.get.mockImplementation(async(url:string,{params}:any={})=>{
     if(url.endsWith('/rankings'))return {data:ranking(params?.month)};
     const start=params.cursor?JSON.parse(params.cursor).start:0;
     return {data:{items:Array.from({length:Math.min(20,260-start)},(_,i)=>({id:String(start+i),name:`${params.filter} ${start+i}`,avatarUrl:null,
       currentStreak:null,longestStreak:null,monthlyAttendances:null,progressPercent:null,goalType:null,publicMessage:null,reactions:{love:0,mine:null}})),
       nextCursor:start+20<260?{start:start+20}:null,hasMore:start+20<260}};
   });
   const {tree,client}=await mount(MemberCommunityPage);
   for(let i=0;i<12;i++)await click(tree,'Cargar más');
   expect(tree.root.findAll((n:any)=>n.props.className==='community-card')).toHaveLength(260);
   expect(button(tree,'Cargar más')).toBeUndefined();
   const data=client.getQueryData(['member-community','gym-a','viewer','all']);
   expect(new Set(data.pages.flatMap((p:any)=>p.items.map((m:any)=>m.id))).size).toBe(260);
   await click(tree,'Objetivos similares');expect(tree.root.findAll((n:any)=>n.props.className==='community-card')).toHaveLength(20);
   await click(tree,'Todos');expect(tree.root.findAll((n:any)=>n.props.className==='community-card')).toHaveLength(20);
   expect(api.get.mock.calls.filter(([u])=>u.endsWith('/community')).at(-1)?.[1].params.cursor).toBeUndefined();
   await act(async()=>tree.root.findByType('select').props.onChange({target:{value:'2026-10'}}));await flush();
   expect(text(tree)).toContain('SQL winner 2026-10');expect(text(tree)).not.toContain('SQL winner 2026-11');
   expect(client.getQueryData(['member-community-rankings','gym-a','viewer','2026-10'])).toBeDefined();
 });
 it('API errors are not rendered as empty community or ranking',async()=>{
   api.get.mockRejectedValue(new Error('network'));const {tree}=await mount(MemberCommunityPage);
   expect(text(tree)).toContain('API_FAILED');expect(text(tree)).not.toContain('Aún no hay perfiles');
   expect(text(tree)).not.toContain('Aún no hay datos suficientes');
 });
 it.each(['home','progress'])('%s does not replace a failed summary with the limited history count',async section=>{
   api.get.mockImplementation(async(url:string)=>{
     if(url==='/members/me/progress')throw Error('RPC failed');
     return {data:url==='/attendances'?{attendances:[{id:'one',status:'valid',attendance_date:'2026-11-02'}]}
       :url==='/calendar'?{hours:[],exceptions:[],location:{timezone:'America/Guayaquil'}}
       :url==='/members/me/fitness-profile'?{fitnessProfile:{id:'profile'}}
       :{memberships:[],streaks:[],progress:[],schedules:[],announcements:[]}};
   });
   const {tree}=await mount(MemberPortalPage,{section});expect(text(tree)).toContain('API_FAILED');
   expect(button(tree,'Reintentar resumen')).toBeDefined();
   if(section==='home')expect(text(tree)).toContain('No disponible');
   else expect(text(tree)).not.toContain('Asistencias totales');
 });
 it('a failed next page preserves existing cards and offers a restart rather than false exhaustion',async()=>{
   api.get.mockImplementation(async(url:string,{params}:any={})=>{
     if(url.endsWith('/rankings'))return {data:ranking()};
     if(params.cursor)throw Error('expired cursor');
     return {data:{items:[{id:'visible',name:'Visible member',avatarUrl:null,currentStreak:null,longestStreak:null,
       monthlyAttendances:null,progressPercent:null,goalType:null,publicMessage:null,reactions:{love:0,mine:null}}],nextCursor:{start:1},hasMore:true}};
   });
   const {tree}=await mount(MemberCommunityPage);await click(tree,'Cargar más');
   expect(text(tree)).toContain('Visible member');expect(text(tree)).toContain('API_FAILED');
   expect(text(tree)).not.toContain('Has llegado al final');expect(text(tree)).not.toContain('Aún no hay perfiles');
   await click(tree,'Volver a cargar la lista');expect(text(tree)).not.toContain('API_FAILED');
 });
});
