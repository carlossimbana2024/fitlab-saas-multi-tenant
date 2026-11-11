import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const req=createRequire(new URL('../../frontend/package.json',import.meta.url));
const React=req('react'),{act,create}=req('react-test-renderer');
const {QueryClient,QueryClientProvider}=req('@tanstack/react-query');
const api={get:vi.fn(),post:vi.fn(),patch:vi.fn(),put:vi.fn()};
const session={user:{email:'member@example.test'},gymUser:{id:'m',gym_id:'g',gym:{timezone:'America/Guayaquil'},profiles:{full_name:'Atleta'}}};
const empty=new Proxy({},{get:()=>()=>null});const modules=new Map();
function load(file:string):any{
 if(modules.has(file))return modules.get(file);
 const out:any={};modules.set(file,out);
 const source=readFileSync(new URL('../../frontend/src/'+file,import.meta.url),'utf8');
 new Function('exports','require','React',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText)(out,(id:string)=>{
   if(id.endsWith('.css'))return {};
   if(id.includes('/services/api'))return {api,apiErrorMessage:()=> 'No pudimos completar la acción.'};
   if(id.includes('/context/AuthContext'))return {useAuth:()=>({session,refresh:vi.fn()})};
   if(id.startsWith('../utils/')||(file.startsWith('utils/')&&id.startsWith('./')))return load('utils/'+id.split('/').at(-1)+'.ts');
   if(id.endsWith('/QueryFeedback'))return load('components/QueryFeedback.tsx');
   if(id.endsWith('/ClassBookingConditions'))return load('components/ClassBookingConditions.tsx');
   if(id.endsWith('/WeightMaintenanceSummary'))return load('components/WeightMaintenanceSummary.tsx');
   if(id.endsWith('/MemberSocialProfile'))return {MemberSocialProfile:({owner}:any)=>owner?.activity??null,SocialPrivacySettings:()=>null};
   if(id==='react-router-dom')return {Link:({children,...props}:any)=>React.createElement('a',props,children),useParams:()=>({}),useSearchParams:()=>[new URLSearchParams(),()=>{}]};
   if(id==='lucide-react'||id.startsWith('../components/')||id.startsWith('./'))return empty;
   return req(id);
 },React);return out;
}
const {MemberPortalPage}=load('pages/MemberPortalPage.tsx'),{MemberCommunityPage}=load('pages/MemberCommunityPage.tsx'),{MemberPaymentsPage}=load('pages/MemberPaymentsPage.tsx');
const trees:any[]=[],clients:any[]=[];(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const flush=()=>act(async()=>{await new Promise(r=>setTimeout(r,20));});
const text=(node:any):string=>node==null?'':Array.isArray(node)?node.map(text).join(' '):typeof node==='object'?text(node.children):String(node);
const visible=(tree:any)=>text(tree.toJSON()).replace(/\s+/g,' ');
async function mount(component=MemberPortalPage,props:any={section:'home'}){
 const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity,staleTime:30_000},mutations:{retry:false}}});clients.push(client);
 let tree:any;await act(async()=>{tree=create(React.createElement(QueryClientProvider,{client},React.createElement(component,props)));});trees.push(tree);await flush();await flush();return {tree,client};
}
async function click(tree:any,label:string){const b=tree.root.findAllByType('button').find((b:any)=>text(b.props.children)===label);expect(b,label).toBeDefined();await act(async()=>{await b.props.onClick();});await flush();}
const failures=new Set<string>();const overrides=new Map<string,any>();
const canonical=()=>({today:'2026-11-05',totalAttendances:0,currentMonthAttendances:0,currentWeekAttendances:0,currentStreak:0,longestStreak:0,hasAttendanceToday:false,latestAttendanceDate:null,weights:[],goal:null,attendanceByMonth:[],attendanceByWeek:[],motivation:{title:'Continúa',message:'',tone:'neutral'}});
const ranking=()=>({ranking:{period:{key:'2026-11',label:'Noviembre'},availablePeriods:[{key:'2026-11',label:'Noviembre'}],categories:Object.fromEntries(['attendance','streak','progress'].map(k=>[k,{title:k,explanation:'',entries:[]}]))}});
function payload(url:string){
 if(overrides.has(url))return overrides.get(url);
 if(url==='/members/me/progress')return {progress:canonical()};
 if(url==='/members/me/fitness-profile')return {fitnessProfile:{id:'f',goal_type:'lose_weight',training_frequency_per_week:3}};
 if(url==='/calendar')return {hours:[],exceptions:[],location:{name:'Ecuador',timezone:'America/Guayaquil'}};
 if(url==='/memberships')return {memberships:[]};if(url==='/attendances')return {attendances:[]};if(url==='/attendances/streaks')return {streaks:[]};
 if(url==='/attendances/weekly-progress')return {progress:[]};if(url==='/activities')return {schedules:[],offersEnabled:false};
 if(url==='/announcements')return {announcements:[]};if(url==='/members/me/community')return {items:[],hasMore:false,nextCursor:null};
 if(url.endsWith('/rankings'))return ranking();
 if(url==='/membership-payment-requests/me')return {memberships:[],plans:[],activeRequest:null,settings:{enabled:false,methods:[],instructions:''},gym:{name:'Gym',timezone:'America/Guayaquil'},location:null};
 if(url==='/activities/me/history'||url==='/membership-payment-requests/me/history')return {items:[],nextCursor:null};
 if(url==='/member-payments/me')return {payments:[],nextCursor:null};throw Error('Unexpected endpoint '+url);
}
beforeEach(()=>{session.gymUser.gym.timezone='America/Guayaquil';failures.clear();overrides.clear();api.get.mockReset();api.get.mockImplementation(async(url:string)=>{if(failures.has(url))throw Error('RPC failed 500 Internal Server Error');return {data:payload(url)};});});
afterEach(async()=>{await act(async()=>trees.splice(0).forEach(t=>t.unmount()));clients.splice(0).forEach(c=>c.clear());vi.useRealTimers();vi.unstubAllGlobals();});

it('A: a successful zero is a real zero, not an error',async()=>{const {tree}=await mount();expect(visible(tree)).toContain('Asistencias válidas 0');expect(visible(tree)).not.toContain('No pudimos');});
it('B/L: failed canonical summary shows neither attendance zero nor a false empty weight history',async()=>{
 failures.add('/members/me/progress');const {tree}=await mount();expect(visible(tree)).toContain('No pudimos cargar tu resumen');expect(visible(tree)).toContain('Asistencias válidas No disponible');
 const p=await mount(MemberPortalPage,{section:'progress'});expect(visible(p.tree)).not.toContain('0 kg');expect(visible(p.tree)).not.toContain('Aún no hay mediciones');expect(visible(p.tree)).not.toContain('Sin progreso calculable');
});
it.each([false,true])('C/D: upcoming classes failed=%s distinguishes empty from error',async failed=>{
 if(failed)failures.add('/activities');const {tree}=await mount();expect(visible(tree).includes('No hay próximas clases publicadas')).toBe(!failed);expect(visible(tree).includes('No pudimos cargar tus próximas clases')).toBe(failed);
 expect(visible(tree)).toContain('Membresía');
});
it.each([false,true])('E/F: membership failed=%s never invents absent coverage',async failed=>{
 if(failed)failures.add('/memberships');const {tree}=await mount();expect(visible(tree).includes('Sin membresía activa')).toBe(!failed);expect(visible(tree).includes('Sin cobertura vigente')).toBe(!failed);
 expect(visible(tree).includes('No pudimos cargar tu membresía')).toBe(failed);expect(visible(tree)).toContain('Asistencias válidas 0');
});
it('initial pending queries show loading, not zero, empty weight history, daily plan or absent membership',async()=>{
 api.get.mockImplementation(()=>new Promise(()=>{}));const {tree}=await mount();expect(visible(tree)).toContain('Cargando');expect(visible(tree)).not.toContain('Sin membresía activa');expect(visible(tree)).not.toContain('Mejor racha: 0');expect(visible(tree)).not.toContain('No hay próximas clases');
 const p=await mount(MemberPortalPage,{section:'progress'});expect(visible(p.tree)).not.toContain('Aún no hay mediciones');expect(visible(p.tree)).not.toContain('Plan de asistencia diaria');
});
it.each([false,true])('G/H: Community failed=%s is not successful empty',async failed=>{if(failed)failures.add('/members/me/community');const {tree}=await mount(MemberCommunityPage,{});expect(visible(tree).includes('Aún no hay perfiles')).toBe(!failed);expect(visible(tree).includes('No pudimos cargar la Comunidad')).toBe(failed);expect(visible(tree)).toContain('Top 3 del mes');});
it.each([false,true])('I/J: ranking failed=%s stays independent of community',async failed=>{if(failed)failures.add('/members/me/community/rankings');const {tree}=await mount(MemberCommunityPage,{});expect(visible(tree).includes('Aún no hay datos suficientes')).toBe(!failed);expect(visible(tree).includes('No pudimos cargar el ranking')).toBe(failed);expect(visible(tree)).toContain('Aún no hay perfiles');});
it('K: next page failure preserves all loaded pages and successful retry appends',async()=>{
 const member=(id:string)=>({id,name:id,goalType:null,currentStreak:null,longestStreak:null,monthlyAttendances:null,progressPercent:null,reactions:{love:0,mine:null}});let fail=true;
 api.get.mockImplementation(async(url:string,config:any)=>{if(url==='/members/me/community'){if(config?.params?.cursor&&fail)throw Error('network');return {data:{items:[member(config?.params?.cursor?'Second':'First')],hasMore:!config?.params?.cursor,nextCursor:config?.params?.cursor?null:{id:'next'}}};}return {data:payload(url)};});
 const {tree}=await mount(MemberCommunityPage,{});await click(tree,'Cargar más');expect(visible(tree)).toContain('First');expect(visible(tree)).not.toContain('Aún no hay perfiles');expect(visible(tree)).toContain('No pudimos actualizar la Comunidad');
 fail=false;await click(tree,'Reintentar siguiente página');expect(visible(tree)).toContain('First');expect(visible(tree)).toContain('Second');
});
it('M/N: failed summary refetch retains valid weight/goal/count; retry recovers without reload',async()=>{
 overrides.set('/members/me/progress',{progress:{...canonical(),totalAttendances:17,currentWeightKg:85,weights:[{id:'w',weightKg:85,measuredOn:'2026-11-01'}],goal:{goalType:'lose_weight',initialWeightKg:90,currentWeightKg:85,targetWeightKg:80,progressPercent:50}}});
 const {tree,client}=await mount(MemberPortalPage,{section:'progress'});expect(visible(tree)).toContain('85 kg');
 failures.add('/members/me/progress');await act(async()=>{await client.refetchQueries({queryKey:['my-progress']});});await flush();expect(visible(tree)).toContain('85 kg');expect(visible(tree)).toContain('17');expect(visible(tree)).toContain('No pudimos actualizar tu resumen');expect(visible(tree)).not.toContain('Aún no hay mediciones');
 failures.clear();await click(tree,'Reintentar tu resumen');expect(visible(tree)).not.toContain('No pudimos actualizar');expect(visible(tree)).toMatch(/50\s*%/);
});
it('partial attendance/calendar failures do not render a false empty history or closed calendar',async()=>{
 failures.add('/attendances');failures.add('/calendar');const {tree}=await mount(MemberPortalPage,{section:'progress'});
 expect(visible(tree)).toContain('No pudimos cargar tus asistencias');expect(visible(tree)).toContain('No pudimos cargar el calendario');expect(visible(tree)).not.toContain('Sin asistencias todavía');expect(tree.root.findAll((n:any)=>n.props.className?.startsWith?.('month-day '))).toHaveLength(0);
 expect(visible(tree)).toContain('Asistencias totales 0');
});
it('weekly API failure is not completed=0 or a daily membership',async()=>{
 overrides.set('/memberships',{memberships:[{id:'ms',status:'active',attendance_mode_snapshot:'weekly',weekly_target_snapshot:3,membership_periods:[{status:'active',starts_on:'2020-01-01',ends_on:'2099-12-31'}]}]});
 failures.add('/attendances/weekly-progress');const {tree}=await mount(MemberPortalPage,{section:'progress'});expect(visible(tree)).toContain('No pudimos cargar tu progreso semanal');expect(visible(tree)).not.toContain('0 de 3');expect(visible(tree)).not.toContain('Plan de asistencia diaria');
});
it('profile/settings error does not invite setup or show false consent, but preserves account controls',async()=>{
 failures.add('/members/me/fitness-profile');const {tree}=await mount(MemberPortalPage,{section:'settings'});expect(visible(tree)).toContain('No pudimos cargar tu perfil deportivo');expect(visible(tree)).not.toContain('Completa tu encuesta');expect(visible(tree)).toContain('Editar cuenta y contraseña');
 const p=await mount(MemberPortalPage,{section:'profile'});expect(visible(p.tree)).not.toContain('Completa tu perfil deportivo');
});
it.each([false,true])('payment query failed=%s never implies an empty payment history',async failed=>{
 if(failed)failures.add('/membership-payment-requests/me');const {tree}=await mount(MemberPaymentsPage,{});expect(visible(tree).includes('Todavía no hay pagos de membresía')).toBe(!failed);expect(visible(tree).includes('No pudimos cargar tu membresía y pagos')).toBe(failed);
});
it('failed payment refetch keeps receipts and independent other-payment error',async()=>{
 const receipt={id:'receipt',amount:30,currency:'USD',status:'confirmed',payment_method:'cash',paid_at:'2026-11-01T12:00Z',receipt_number:12,receipt_verification_token:'token'};
 api.get.mockImplementation(async(url:string,config?:any)=>{
  if(failures.has(url)||failures.has(config?.params?.kind))throw Error('API unavailable');
  return {data:url==='/member-payments/me'&&config?.params?.kind==='membership'?{payments:[receipt],nextCursor:null}:payload(url)};
 });
 const {tree,client}=await mount(MemberPaymentsPage,{});failures.add('/membership-payment-requests/me');failures.add('other');await act(async()=>{await client.refetchQueries({queryKey:['my-membership-payments']});await client.refetchQueries({queryKey:['my-payments-history']});});await flush();
 expect(visible(tree)).toContain('Ver recibo 12');expect(visible(tree)).toContain('No pudimos actualizar tu membresía y pagos');expect(visible(tree)).toContain('No pudimos actualizar otros pagos');
});

describe('FIT-MEMBER-019 paginated histories in the member portal',()=>{
 const classItem=(id:string)=>({id,starts_at:'2026-11-05T15:00Z',ends_at:'2026-11-05T16:00Z',status:'completed',
  activity:{name:id,is_active:false},location:{name:'Sucursal anterior',timezone:'America/Guayaquil',is_active:false},
  myBooking:{id:`booking-${id}`,status:'attended',payment_state:'refunded',economic_terms:{billing_mode:'additional_fee',agreed_amount:19,currency:'USD',evidence_state:'verified'}}});
 const payment=(id:string,status='confirmed')=>({id,amount:30,currency:'USD',payment_method:'cash',status,paid_at:'2026-11-01T12:00Z',receipt_number:id,receipt_verification_token:id});
 const buttonIn=(container:any,label:string)=>container.findAllByType('button').find((b:any)=>text(b.props.children).trim()===label);
 const history=(tree:any,title:string)=>tree.root.findAllByType('section').find((s:any)=>s.findAllByType('h2').some((h:any)=>text(h.props.children)===title));
 const run=async(button:any)=>{expect(button).toBeDefined();await act(async()=>{button.props.onClick();});await flush();};
 const change=async(input:any,value:string)=>{await act(async()=>input.props.onChange({target:{value}}));await flush();};

 it('class pages append, retry locally on failure, and restart when the month changes (including an empty month)',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-20T12:00:00Z'));
  let failPage=true;
  api.get.mockImplementation(async(url:string,config?:any)=>{
   if(url!=='/activities/me/history')return {data:payload(url)};
   const {from,to,cursor}=config.params;
   if(from.startsWith('2026-10')){expect(cursor).toBeUndefined();return {data:{items:[],nextCursor:null}};}
   expect([from,to]).toEqual(['2026-11-01T05:00:00.000Z','2026-12-01T05:00:00.000Z']);
   if(cursor){expect(cursor).toBe('nov-page-2');if(failPage)throw Error('next page failed');}
   return {data:cursor?{items:[classItem('Clase segunda')],nextCursor:null}:{items:[classItem('Clase primera')],nextCursor:'nov-page-2'}};
  });
  const {tree}=await mount(MemberPortalPage,{section:'classes'});
  const section=()=>history(tree,'Historial de mis clases');
  expect(visible(tree)).toContain('Clase primera');expect(visible(tree)).toContain('Actividad y sucursal no disponibles');
  expect(visible(tree)).toContain('Reserva: Asististe');expect(visible(tree)).toContain('importe acordado');
  await run(buttonIn(section(),'Cargar más'));
  expect(visible(tree)).toContain('Clase primera');expect(visible(tree)).toContain('No pudimos cargar más registros');
  expect(visible(tree)).not.toContain('No tienes clases en este mes');
  failPage=false;await run(buttonIn(section(),'Reintentar cargar más'));
  expect(visible(tree)).toContain('Clase primera');expect(visible(tree)).toContain('Clase segunda');
  expect(buttonIn(section(),'Cargar más')).toBeUndefined();
  const month=()=>tree.root.findAllByType('input').find((node:any)=>node.props.type==='month');
  await change(month(),'2026-10');
  expect(visible(tree)).toContain('No tienes clases en este mes');expect(visible(tree)).not.toContain('Clase primera');
  await change(month(),'2026-11');
  expect(visible(tree)).toContain('Clase primera');expect(visible(tree)).not.toContain('Clase segunda');
  expect(api.get.mock.calls.filter(([u])=>u==='/activities/me/history').at(-1)?.[1]?.params.cursor).toBeUndefined();
 });

 it('a failed first class-history page is not shown as an empty month',async()=>{
  failures.add('/activities/me/history');const {tree}=await mount(MemberPortalPage,{section:'classes'});
  expect(visible(tree)).toContain('No pudimos cargar el historial de clases');
  expect(visible(tree)).not.toContain('No tienes clases en este mes');
  expect(visible(tree)).toContain('No hay próximas clases publicadas');
 });

 it('payment histories keep receipts, separate filters and first-page errors, and retry a later failure',async()=>{
  let failNext=true;
  api.get.mockImplementation(async(url:string,config?:any)=>{
   if(url!=='/member-payments/me')return {data:payload(url)};
   const {kind,status,cursor}=config.params;
   if(kind==='other')throw Error('other unavailable');
   if(status){expect(cursor).toBeUndefined();return {data:{payments:[payment('Anulado','voided')],nextCursor:null}};}
   if(cursor&&failNext)throw Error('next page failed');
   return {data:cursor?{payments:[payment('B','refunded')],nextCursor:null}:{payments:[payment('A')],nextCursor:'more'}};
  });
  const {tree}=await mount(MemberPaymentsPage,{});
  const section=()=>history(tree,'Historial de pagos');
  expect(visible(tree)).toContain('Ver recibo A');expect(visible(tree)).toContain('No pudimos cargar otros pagos registrados');
  expect(visible(tree)).not.toContain('Todavía no hay otros pagos');
  await run(buttonIn(section(),'Cargar más'));expect(visible(tree)).toContain('Ver recibo A');expect(visible(tree)).toContain('No pudimos cargar más registros');
  failNext=false;await run(buttonIn(section(),'Reintentar cargar más'));
  expect(visible(tree)).toContain('Ver recibo B');expect(visible(tree)).toContain('Reembolsado');
  await change(section().findByType('select'),'voided');
  expect(visible(tree)).toContain('Ver recibo Anulado');expect(visible(tree)).not.toContain('Ver recibo B');
  await change(section().findByType('select'),'');
  expect(visible(tree)).toContain('Ver recibo A');expect(visible(tree)).not.toContain('Ver recibo B');
 });

 it('review status changes revalidate all loaded request pages with fresh cursors and keep older proofs reachable',async()=>{
  const pending={id:'pending',status:'pending',channel:'fitlab',plan_snapshot:{name:'En revisión'},amount:30,currency:'USD',created_at:'2026-11-01'};
  let reviewed=false;
  const requestPage=(cursor?:string)=>cursor
   ? {items:[{...pending,id:'old',status:'rejected',plan_snapshot:{name:`Anterior ${cursor}`}}],nextCursor:null}
   : {items:[reviewed?{...pending,status:'approved',plan_snapshot:{name:'Ya aprobada'}}:pending],nextCursor:reviewed?'updated':'original'};
  api.get.mockImplementation(async(url:string,config?:any)=>({data:url==='/membership-payment-requests/me'
   ?{...payload(url),activeRequest:reviewed?null:pending}:url==='/membership-payment-requests/me/history'
   ?requestPage(config?.params.cursor):url.endsWith('/old/proof')?{url:'https://proof.invalid/signed'}:payload(url)}));
  const {tree,client}=await mount(MemberPaymentsPage,{});
  const section=()=>history(tree,'Mis solicitudes');
  await run(buttonIn(section(),'Cargar más'));
  expect(visible(tree)).toContain('Anterior original');expect(visible(tree)).toContain('Pago en revisión');
  reviewed=true;
  await act(async()=>{await client.refetchQueries({queryKey:['my-membership-payments']});});await flush();await flush();
  expect(visible(tree)).toContain('Ya aprobada');expect(visible(tree)).toContain('Anterior updated');
  expect(visible(tree)).not.toContain('Anterior original');expect(visible(tree)).not.toContain('Pago en revisión');
  const oldRow=section().findAllByType('article').find((row:any)=>text(row).includes('Anterior updated'));
  await run(buttonIn(oldRow,'Comprobante'));
  expect(visible(tree)).toContain('Descargar comprobante');
  expect(api.get.mock.calls.filter(([u])=>u==='/membership-payment-requests/me/history').map(([,c])=>c.params.cursor)).toEqual([undefined,'original',undefined,'updated']);
 });
});

describe('FIT-MEMBER-018 membership coverage in both real views',()=>{
 const useDate=(instant:string)=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(instant));};
 const coverage=(start:string,end:string,status='active')=>{
  const memberships=[{id:'coverage',status,plans:{name:'Plan mensual'},price_at_purchase:30,currency:'USD',attendance_mode_snapshot:'daily',membership_periods:[{starts_on:start,ends_on:end,status:'active'}]}];
  const payments={...payload('/membership-payment-requests/me'),memberships};
  overrides.set('/memberships',{memberships});overrides.set('/membership-payment-requests/me',payments);
 };
 const readCoverage=(home:any,payments:any)=>[
  text(home.root.findByProps({className:'home-membership-copy'})),
  text(payments.root.findByProps({className:'panel membership-payment-summary'})),
 ];
 const mountBoth=async()=>[await mount(),await mount(MemberPaymentsPage,{})] as const;

 it.each([
  ['2026-11-01','2026-11-26','active','21 días restantes'],
  ['2026-11-01','2026-11-06','active','1 día restante'],
  ['2026-11-01','2026-11-05','active','Vence hoy'],
  ['2026-11-05','2026-11-05','active','Vence hoy'],
  ['2026-11-01','2026-11-04','active','Cobertura vencida'],
  ['2026-11-01','2026-11-04','expired','Cobertura vencida'],
  ['2026-11-06','2026-11-26','active','Comienza el 2026-11-06'],
  ['2026-11-01','2026-11-26','paused','Membresía pausada'],
 ])('same label in Inicio and Pagos for %s → %s (%s): %s',async(start,end,status,label)=>{
  useDate('2026-11-06T04:59:59Z');coverage(start,end,status);
  const [home,payments]=await mountBoth();
  for(const summary of readCoverage(home.tree,payments.tree)){
   expect(summary).toContain(label);expect(summary).not.toMatch(/-\d+ días? restante|\b0 días? restante|\b1 días restantes/);
   if(label.startsWith('Comienza')||status==='paused')expect(summary).not.toContain('restante');
  }
  if(label==='Vence hoy')expect(visible(home.tree)).toContain('Tu membresía vence hoy.');
 });

 it('moves both views from 1 day to today to expired without refetching memberships or reloading',async()=>{
  useDate('2026-11-05T04:59:59Z');coverage('2026-11-01','2026-11-05');
  const tab=Object.assign(new EventTarget(),{visibilityState:'visible'});
  vi.stubGlobal('document',tab);vi.stubGlobal('window',new EventTarget());
  const [home,payments]=await mountBoth();
  const expectBoth=(label:string)=>readCoverage(home.tree,payments.tree).forEach(summary=>expect(summary).toContain(label));
  expectBoth('1 día restante');
  await act(async()=>{vi.setSystemTime(new Date('2026-11-05T05:00:00Z'));tab.dispatchEvent(new Event('visibilitychange'));});
  expectBoth('Vence hoy');
  // The progress fixture keeps its previous date; membership rendering must not depend on it.
  await act(async()=>{vi.setSystemTime(new Date('2026-11-06T05:00:00Z'));tab.dispatchEvent(new Event('visibilitychange'));});
  expectBoth('Cobertura vencida');
  expect(api.get.mock.calls.filter(([url])=>url==='/memberships'||url==='/membership-payment-requests/me')).toHaveLength(2);
 });

 it('uses the gym timezone from the session, not the branch, device or progress response',async()=>{
  session.gymUser.gym.timezone='America/New_York';
  useDate('2026-07-06T04:00:00Z');coverage('2026-07-06','2026-07-06');
  overrides.set('/calendar',{hours:[],exceptions:[],location:{name:'Hawaii',timezone:'Pacific/Honolulu'}});
  const previous=process.env.TZ;
  process.env.TZ='America/Los_Angeles';
  try{
   expect(new Date().getDate()).toBe(5); // The simulated device is still on July 5.
   const [home,payments]=await mountBoth();
   for(const summary of readCoverage(home.tree,payments.tree))expect(summary).toContain('Vence hoy');
  }finally{if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;}
 });

 it('reopening either view revalidates coverage inside the default cache window',async()=>{
  useDate('2026-11-05T17:00:00Z');coverage('2026-11-01','2026-11-05');
  const [home,payments]=await mountBoth();
  for(const summary of readCoverage(home.tree,payments.tree))expect(summary).toContain('Vence hoy');
  await act(async()=>{home.tree.update(null);payments.tree.update(null);});
  vi.setSystemTime(new Date('2026-11-05T17:00:01Z'));
  coverage('2026-11-01','2026-11-26');
  await act(async()=>{
   home.tree.update(React.createElement(QueryClientProvider,{client:home.client},React.createElement(MemberPortalPage,{section:'home'})));
   payments.tree.update(React.createElement(QueryClientProvider,{client:payments.client},React.createElement(MemberPaymentsPage)));
  });await flush();
  for(const summary of readCoverage(home.tree,payments.tree))expect(summary).toContain('21 días restantes');
  expect(api.get.mock.calls.filter(([url])=>url==='/memberships'||url==='/membership-payment-requests/me')).toHaveLength(4);
 });

 it.each([true,false])('API failure=%s is not an invented countdown or an empty membership',async failed=>{
  if(failed){failures.add('/memberships');failures.add('/membership-payment-requests/me');}
  const [home,payments]=await mountBoth();
  for(const {tree} of [home,payments]){
   expect(visible(tree)).not.toMatch(/\d+ días? restante|Vence hoy|Cobertura vencida/);
   expect(visible(tree).includes('Sin cobertura vigente')).toBe(!failed);
   expect(visible(tree).includes('No pudimos cargar tu membresía')).toBe(failed);
  }
  if(!failed)expect(visible(payments.tree)).toContain('Elige tu primera membresía');
 });
});
