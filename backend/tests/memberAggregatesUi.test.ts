import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const req=createRequire(new URL('../../frontend/package.json',import.meta.url));
const React=req('react');const {act,create}=req('react-test-renderer');
const {QueryClient,QueryClientProvider}=req('@tanstack/react-query');
const mutations=new Map<string,any>();
const api={get:vi.fn(),post:vi.fn(),put:vi.fn(),patch:vi.fn()};
let session:any;
let profileOwner:any;
const authRefresh=vi.fn();
const noop=()=>null;
const emptyModules=new Proxy({}, {get:()=>noop});
function load(file:string){
 const exports:any={};const source=readFileSync(new URL(`../../frontend/src/${file}`,import.meta.url),'utf8');
 new Function('exports','require','React',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText)(exports,(id:string)=>{
   if(id.endsWith('.css'))return {};
   if(id.includes('/services/api'))return {api,apiErrorMessage:()=> 'API_FAILED'};
   if(id.includes('/context/AuthContext'))return {useAuth:()=>({session,refresh:authRefresh,applyConfirmedProfile:(userId:string,profile:any)=>{
     if(session?.user.id===userId)session={...session,gymUser:{...session.gymUser,profiles:{...session.gymUser.profiles,full_name:profile.fullName,phone:profile.phone||null}}};
   }})};
   if(id==='@tanstack/react-query')return {...req(id),useMutation:(options:any)=>{const mutation=req(id).useMutation(options);mutations.set(options.mutationFn.toString(),mutation);return mutation;}};
   if(['membershipCoverage','currentPortalDate','currentWeeklyProgress','portalTime','classScheduleHours','branchOpenStatus','memberQueryInvalidation'].some(name=>id===`../utils/${name}`||id===`./${name}`))return load(`utils/${id.split('/').at(-1)}.ts`);
   if(id==='../components/BranchOpenStatus')return load('components/BranchOpenStatus.tsx');
   if(id==='../components/QueryFeedback')return load('components/QueryFeedback.tsx');
   if(id==='../components/MemberAccountDialog')return load('components/MemberAccountDialog.tsx');
   if(id==='./ProfileDialog')return {ProfileDialog:({children}:any)=>React.createElement('section',null,children)};
   if(id==='../components/MemberSocialProfile')return {MemberSocialProfile:({owner}:any)=>{profileOwner=owner;return null;},SocialPrivacySettings:()=>null};
   if(id.includes('/components/AttendanceQrCard'))return {AttendanceQrCard:({hasAttendanceToday}:any)=>React.createElement('div',{'data-attended-today':hasAttendanceToday})};
   if(id==='react-router-dom')return {Link:({children}:any)=>React.createElement('a',null,children)};
   if(id==='lucide-react'||id.startsWith('../components/')||id.startsWith('../utils/'))return emptyModules;
   return req(id);
 },React);return exports;
}
const {MemberPortalPage}=load('pages/MemberPortalPage.tsx');const {MemberCommunityPage}=load('pages/MemberCommunityPage.tsx');
const {BranchOpenStatus}=load('components/BranchOpenStatus.tsx');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const trees:any[]=[];const clients:any[]=[];
const flush=async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,30));});};
async function mount(component:any,props={}){
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity},mutations:{retry:false}}});clients.push(client);
 let tree:any;await act(async()=>{tree=create(React.createElement(QueryClientProvider,{client},React.createElement(component,props)));});trees.push(tree);
 await flush();await flush();return {tree,client};
}
const text=(tree:any)=>JSON.stringify(tree.toJSON());
const button=(tree:any,label:string)=>tree.root.findAllByType('button').find((b:any)=>b.props.children===label);
async function click(tree:any,label:string){await act(async()=>button(tree,label).props.onClick());await flush();}
const ranking=(month='2026-11')=>({ranking:{period:{key:month,label:month,from:month+'-01',to:month+'-28',isCurrent:false},availablePeriods:[{key:'2026-11',label:'Nov'},{key:'2026-10',label:'Oct'}],historyMode:'reconstructed',categories:Object.fromEntries(['attendance','streak','progress'].map(key=>[key,{title:key,explanation:key,entries:[{position:1,memberUserId:'winner',name:`SQL winner ${month}`,avatarUrl:null,value:123,displayValue:'123 SQL',goalType:null}]}]))}});
beforeEach(()=>{session={user:{id:'auth-viewer',email:'reader@example.test'},gymUser:{id:'viewer',gym_id:'gym-a',profiles:{full_name:'Reader'}}};Object.values(api).forEach(mock=>mock.mockReset());authRefresh.mockReset().mockResolvedValue(undefined);mutations.clear();});
afterEach(async()=>{await act(async()=>trees.splice(0).forEach(t=>t.unmount()));clients.splice(0).forEach(c=>c.clear());vi.useRealTimers();vi.unstubAllGlobals();});

describe('FIT-MEMBER-015 real mutation integration',()=>{
 const action=(path:string)=>[...mutations.entries()].find(([source])=>source.includes(path))![1];
 function setup(){
  let weight=85,goal='lose_weight',visible=true;
  api.get.mockImplementation(async(url:string)=>({data:url==='/members/me/progress'?{progress:{currentWeightKg:weight,weights:[],goal:{goalType:goal,initialWeightKg:90,currentWeightKg:weight,targetWeightKg:80,progressPercent:50},attendanceByMonth:[],attendanceByWeek:[],motivation:{title:'SQL summary'}}}
   :url==='/members/me/fitness-profile'?{fitnessProfile:{id:'fitness',goal_type:goal,show_in_community:visible}}
   :url==='/calendar'?{hours:[],exceptions:[],location:{timezone:'America/Guayaquil'}}
   :url.endsWith('/rankings')?ranking()
   :url==='/members/me/community'?{items:[],hasMore:false,nextCursor:null}
   :{memberships:[],attendances:[],streaks:[],progress:[],schedules:[],announcements:[]}}));
  api.post.mockImplementation(async()=>{weight=84;return {data:{}};});
  api.put.mockImplementation(async()=>{goal='gain_weight';return {data:{}};});
  api.patch.mockImplementation(async()=>{visible=false;return {data:{}};});
 }
 const seed=(client:any)=>{
  client.setQueryData(['member-community','gym-a','viewer','all'],{pages:[{items:[{id:'old'}]}],pageParams:[null]});
  client.setQueryData(['member-social-profile','me'],{currentWeight:85});
  client.setQueryData(['member-community-rankings','gym-a','viewer','2026-11'],{old:true});
  client.setQueryData(['member-community-rankings','other','reader','2026-11'],{old:true});
  client.setQueryData(['branch-open-status','gym-a','viewer','branch'],{isOpenNow:true});
 };
 it('A: weight write refreshes canonical summary used by Home/Progress/Profile and invalidates shared metrics',async()=>{
  setup();const {tree,client}=await mount(MemberPortalPage,{section:'progress'});seed(client);
  await act(async()=>{await action('/members/me/weight').mutateAsync();});await flush();
  expect(client.getQueryCache().findAll({queryKey:['my-progress']})[0].state.data.currentWeightKg).toBe(84);
  expect(client.getQueryState(['member-social-profile','me']).isInvalidated).toBe(true);
  expect(client.getQueryState(['member-community-rankings','gym-a','viewer','2026-11']).isInvalidated).toBe(true);
  expect(client.getQueryData(['member-community','gym-a','viewer','all'])).toBeUndefined();
  expect(client.getQueryState(['member-community-rankings','other','reader','2026-11']).isInvalidated).toBe(false);
  expect(client.getQueryState(['branch-open-status','gym-a','viewer','branch']).isInvalidated).toBe(false);
  await act(async()=>tree.update(React.createElement(QueryClientProvider,{client},React.createElement(MemberPortalPage,{section:'home'}))));await flush();
  expect(client.getQueryCache().findAll({queryKey:['my-progress']})[0].state.data.currentWeightKg).toBe(84);
 });
 it('B: changing goal refreshes fitness, canonical Progress and Community',async()=>{
  setup();const {client}=await mount(MemberPortalPage,{section:'progress'});seed(client);
  await act(async()=>{await action('/members/me/fitness-profile').mutateAsync({weightKg:'85',heightCm:'175',goalType:'gain_weight',experienceLevel:'beginner',trainingFrequencyPerWeek:'3',availableDays:[1],targetWeightKg:'90',preferredTrainingType:'',goalHorizonMonths:'',publicMessage:''});});await flush();
  expect(client.getQueryData(['my-fitness-profile']).goal_type).toBe('gain_weight');
  expect(client.getQueryCache().findAll({queryKey:['my-progress']})[0].state.data.goal.goalType).toBe('gain_weight');
  expect(client.getQueryState(['member-social-profile','me']).isInvalidated).toBe(true);
  expect(client.getQueryData(['member-community','gym-a','viewer','all'])).toBeUndefined();
 });
 it.each([true,false])('C/G: privacy success=%s refreshes only on confirmed PATCH',async success=>{
  setup();const {client}=await mount(MemberPortalPage,{section:'settings'});seed(client);
  if(!success)api.patch.mockRejectedValueOnce(new Error('denied'));
  await act(async()=>{await action('/members/me/privacy').mutateAsync({key:'showInCommunity',value:false}).catch(()=>{});});await flush();
  expect(api.patch).toHaveBeenCalledWith('/members/me/privacy',{key:'showInCommunity',value:false});
  expect(client.getQueryData(['my-fitness-profile']).show_in_community).toBe(!success);
  expect(client.getQueryState(['member-social-profile','me']).isInvalidated).toBe(success);
  expect(client.getQueryState(['member-community-rankings','gym-a','viewer','2026-11']).isInvalidated).toBe(success);
  expect(client.getQueryState(['branch-open-status','gym-a','viewer','branch']).isInvalidated).toBe(false);
 });
 it('G: rejected weight write preserves cached metrics and never marks success',async()=>{
  setup();const {client}=await mount(MemberPortalPage,{section:'progress'});seed(client);
  api.post.mockRejectedValueOnce(new Error('denied'));
  await act(async()=>{await action('/members/me/weight').mutateAsync().catch(()=>{});});
  expect(client.getQueryCache().findAll({queryKey:['my-progress']})[0].state.data.currentWeightKg).toBe(85);
  expect(client.getQueryState(['member-social-profile','me']).isInvalidated).toBe(false);
  expect(client.getQueryData(['member-community','gym-a','viewer','all']).pages[0].items[0].id).toBe('old');
 });
 it.each([true,false])('D/G: reaction success=%s reconciles card counter without touching rankings',async success=>{
  let loved=false;api.get.mockImplementation(async(url:string)=>({data:url.endsWith('/rankings')?ranking():{items:[{id:'person',name:'Person',currentStreak:null,longestStreak:null,monthlyAttendances:null,goalType:null,progressPercent:null,reactions:{love:loved?1:0,mine:loved?'love':null}}],hasMore:false,nextCursor:null}}));
  api.post.mockImplementation(async()=>{if(!success)throw Error('denied');loved=true;return {data:{reaction:{reacted:true}}};});
  const {tree,client}=await mount(MemberCommunityPage);const getCalls=api.get.mock.calls.length;
  await act(async()=>{await action('/members/me/community/reactions').mutateAsync('person').catch(()=>{});});await flush();
  const card=tree.root.findAllByType('button').find((b:any)=>b.props['aria-pressed']!==undefined&&b.findAllByType('b').length>0);
  expect(card.props['aria-pressed']).toBe(success);
  expect(client.getQueryData(['member-community','gym-a','viewer','all']).pages[0].items[0].reactions.love).toBe(success?1:0);
  expect(api.get.mock.calls.slice(getCalls).some(([url])=>url.endsWith('/rankings'))).toBe(false);
 });
 it('E/F: reserve and cancel reconcile both upcoming Home/Classes and history, not attendance or branch',async()=>{
  setup();const {client}=await mount(MemberPortalPage,{section:'classes'});
  const key=client.getQueryCache().findAll({queryKey:['my-activities','upcoming']})[0].queryKey;
  let booked=false;api.get.mockImplementation(async(url:string)=>({data:url==='/activities'?{schedules:[{id:'class',starts_at:'2099-01-01T12:00Z',ends_at:'2099-01-01T13:00Z',status:'scheduled',activity:{name:'Boxeo',billing_mode:'included'},location:{name:'Branch',timezone:'America/Guayaquil'},capacity:1,available:booked?0:1,myBooking:booked?{id:'booking',status:'reserved'}:null}]}:{}}));
  api.post.mockImplementation(async()=>{booked=true;return {data:{}};});api.patch.mockImplementation(async()=>{booked=false;return {data:{}};});
  const before=client.getQueryCache().findAll({queryKey:['my-attendances']})[0].state.dataUpdatedAt;
  await act(async()=>{await action('/bookings/self').mutateAsync('class');});await flush();
  expect(client.getQueryData(key).schedules[0].myBooking.status).toBe('reserved');expect(client.getQueryData(key).schedules[0].available).toBe(0);
  await act(async()=>{await action('/cancel-self').mutateAsync('booking');});await flush();
  expect(client.getQueryData(key).schedules[0].myBooking).toBeNull();expect(client.getQueryData(key).schedules[0].available).toBe(1);
  expect(client.getQueryCache().findAll({queryKey:['my-attendances']})[0].state.dataUpdatedAt).toBe(before);
 });
 it.each(['/waitlist/self','Salida o rechazo','/accept-self'])('waitlist action %s refreshes upcoming + history only after confirmation',async fragment=>{
  setup();const {client}=await mount(MemberPortalPage,{section:'classes'});const before=api.get.mock.calls.filter(([u])=>u==='/activities').length;
  api.post.mockResolvedValue({data:{}});api.patch.mockResolvedValue({data:{waitlist:{state:'cancelled'}}});
  await act(async()=>{await action(fragment).mutateAsync('id');});await flush();
  expect(api.get.mock.calls.filter(([u])=>u==='/activities').length-before).toBe(2);
  expect(client.getQueryCache().findAll({queryKey:['my-progress']})[0].state.data.currentWeightKg).toBe(85);
 });
 it.each([false,true])('failed class mutation: known conflict=%s reconciles only if authoritative state may have changed',async conflict=>{
  setup();const {tree}=await mount(MemberPortalPage,{section:'classes'});const before=api.get.mock.calls.filter(([u])=>u==='/activities').length;
  api.post.mockRejectedValueOnce(conflict?{response:{status:409,data:{error:{code:'CLASS_WAITLIST_OFFER_EXPIRED'}}}}:new Error('network'));
  await act(async()=>{await action('/bookings/self').mutateAsync('id').catch(()=>{});});await flush();
  expect(api.get.mock.calls.filter(([u])=>u==='/activities').length-before).toBe(conflict?2:0);
  expect(text(tree)).not.toContain('Reserva confirmada');
 });
 it('FIT-MEMBER-017 avatar retry reuses uploaded path and invalidates identity only after association',async()=>{
  setup();const {tree,client}=await mount(MemberPortalPage,{section:'profile'});seed(client);
  const upload=vi.fn(async()=>({ok:true}));vi.stubGlobal('fetch',upload);
  api.post.mockResolvedValue({data:{upload:{signedUrl:'https://storage.invalid/upload',path:'g/profile/image.png'}}});
  api.put.mockRejectedValueOnce(new Error('finalize failed')).mockResolvedValue({data:{avatarPath:'g/profile/image.png'}});
  const file=new File(['image'],'image.png',{type:'image/png'});
  await act(async()=>{profileOwner.onAvatarFile(file);profileOwner.onAvatarFile(file);});await flush();
  expect(api.post).toHaveBeenCalledTimes(1);expect(upload).toHaveBeenCalledTimes(1);
  expect(client.getQueryState(['member-social-profile','me']).isInvalidated).toBe(false);
  expect(text(tree)).toContain('Reintentar guardar foto');
  await click(tree,'Reintentar guardar foto');
  expect(api.post).toHaveBeenCalledTimes(1);expect(upload).toHaveBeenCalledTimes(1);expect(api.put).toHaveBeenCalledTimes(2);
  expect(text(tree)).toContain('Foto guardada.');
  expect(client.getQueryState(['member-social-profile','me']).isInvalidated).toBe(true);
 });
 it('FIT-MEMBER-017 reopening after failed identity read preserves the confirmed name on the next phone edit',async()=>{
  setup();const {tree}=await mount(MemberPortalPage,{section:'profile'});
  api.put.mockResolvedValue({data:{}});authRefresh.mockRejectedValueOnce(new Error('session read failed'));
  await act(async()=>profileOwner.onEditAccount());
  const inputs=()=>tree.root.findAllByType('input').filter((n:any)=>n.props.type!=='password');
  await act(async()=>inputs()[0].props.onChange({target:{value:'Nombre confirmado'}}));
  await act(async()=>{await tree.root.findByType('form').props.onSubmit({preventDefault(){}});});
  expect(text(tree)).toContain('no pudimos actualizar todas las vistas');
  await click(tree,'Cerrar');await act(async()=>profileOwner.onEditAccount());
  expect(inputs()[0].props.value).toBe('Nombre confirmado');
  await act(async()=>inputs()[1].props.onChange({target:{value:'0990000001'}}));
  await act(async()=>{await tree.root.findByType('form').props.onSubmit({preventDefault(){}});});
  expect(api.put.mock.calls.filter(([url])=>url==='/members/me/profile')).toEqual([
    ['/members/me/profile',{fullName:'Nombre confirmado',phone:null}],
    ['/members/me/profile',{fullName:'Nombre confirmado',phone:'0990000001'}],
  ]);
 });
});

it.each([true,false])('FIT-MEMBER-014 UI renders authoritative SQL state %s',async isOpenNow=>{
 api.get.mockResolvedValue({data:{isOpenNow,timezone:'America/Guayaquil',nextTransitionAt:null,revalidateAt:new Date(Date.now()+86400000).toISOString(),validUntil:new Date(Date.now()+86400000).toISOString()}});
 const {tree}=await mount(BranchOpenStatus,{gymId:'g',memberId:'m',locationId:'l'});
 expect(text(tree)).toContain(isOpenNow?'Abierto ahora':'Cerrado ahora');
});
it('FIT-MEMBER-014 API failure is not closed',async()=>{
 api.get.mockRejectedValue(new Error('RPC failed'));
 const {tree}=await mount(BranchOpenStatus,{gymId:'g',memberId:'m',locationId:'l'});
 expect(text(tree)).toContain('Estado de sucursal no disponible');expect(text(tree)).not.toContain('Cerrado ahora');
});
it.each([true,false])('FIT-MEMBER-014 transition refetch changes state to %s',async target=>{
 vi.stubGlobal('window',new EventTarget());vi.stubGlobal('document',Object.assign(new EventTarget(),{visibilityState:'visible'}));
 let calls=0;
 api.get.mockImplementation(async()=>{calls++;return {data:{isOpenNow:calls>1?target:!target,timezone:'America/New_York',nextTransitionAt:new Date(Date.now()+(calls>1?86400000:1000)).toISOString(),revalidateAt:new Date(Date.now()+86400000).toISOString(),validUntil:new Date(Date.now()+86400000).toISOString()}};});
 const {tree}=await mount(BranchOpenStatus,{gymId:'g',memberId:'m',locationId:'a'});
 expect(text(tree)).toContain(target?'Cerrado ahora':'Abierto ahora');
 await act(async()=>{await new Promise(r=>setTimeout(r,1100));});await flush();
 expect(text(tree)).toContain(target?'Abierto ahora':'Cerrado ahora');expect(calls).toBe(2);
});
it('FIT-MEMBER-014 branch change never shows previous state',async()=>{
 api.get.mockResolvedValue({data:{isOpenNow:true,timezone:'America/Guayaquil',nextTransitionAt:null,revalidateAt:new Date(Date.now()+86400000).toISOString(),validUntil:new Date(Date.now()+86400000).toISOString()}});
 const {tree,client}=await mount(BranchOpenStatus,{gymId:'g',memberId:'m',locationId:'a'});
 api.get.mockImplementation(()=>new Promise(()=>{}));
 await act(async()=>tree.update(React.createElement(QueryClientProvider,{client},React.createElement(BranchOpenStatus,{gymId:'g',memberId:'m',locationId:'b'}))));
 expect(text(tree)).toContain('Consultando horario');expect(text(tree)).not.toContain('Abierto ahora');
});

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
   expect(text(tree)).toContain('No pudimos cargar');expect(text(tree)).not.toContain('Aún no hay perfiles');
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
   const {tree}=await mount(MemberPortalPage,{section});expect(text(tree)).toContain('No pudimos cargar');
   expect(button(tree,'Reintentar tu resumen')).toBeDefined();
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
   expect(text(tree)).toContain('Visible member');expect(text(tree)).toContain('No pudimos actualizar');
   expect(text(tree)).not.toContain('Has llegado al final');expect(text(tree)).not.toContain('Aún no hay perfiles');
   await click(tree,'Volver a cargar la lista');expect(text(tree)).not.toContain('No pudimos actualizar');
 });
});
