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
 const exports:any={};const source=readFileSync(new URL(`../../frontend/src/pages/${file}.tsx`,import.meta.url),'utf8');
 new Function('exports','require','React',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText)(exports,(id:string)=>{
   if(id.endsWith('.css'))return {};
   if(id.includes('/services/api'))return {api,apiErrorMessage:()=> 'API_FAILED'};
   if(id.includes('/context/AuthContext'))return {useAuth:()=>({session,refresh:vi.fn()})};
   if(id.includes('/utils/membershipCoverage'))return {selectMembershipCoverage:()=>({})};
   if(id==='react-router-dom')return {Link:({children}:any)=>React.createElement('a',null,children)};
   if(id==='lucide-react'||id.startsWith('../components/')||id.startsWith('../utils/'))return emptyModules;
   return req(id);
 },React);return exports;
}
const {MemberPortalPage}=load('MemberPortalPage');const {MemberCommunityPage}=load('MemberCommunityPage');
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
afterEach(async()=>{await act(async()=>trees.splice(0).forEach(t=>t.unmount()));clients.splice(0).forEach(c=>c.clear());});
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
