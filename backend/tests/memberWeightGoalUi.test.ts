import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const req=createRequire(new URL('../../frontend/package.json',import.meta.url));
const React=req('react'),{act,create}=req('react-test-renderer');
const noop=()=>null,empty=new Proxy({},{get:()=>noop});
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const trees:any[]=[];
function load(path:string,expose=''){
 const exports:any={};
 const source=readFileSync(new URL('../../frontend/src/'+path+'.tsx',import.meta.url),'utf8')+expose;
 new Function('exports','require','React',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText)(
  exports,(id:string)=>{
   if(id.includes('WeightMaintenanceSummary'))return maintenance;
   if(id.endsWith('.css'))return {};
   if(id==='react-router-dom')return {Link:({children}:any)=>React.createElement('a',null,children)};
   if(id==='lucide-react'||id.startsWith('../components/')||id.startsWith('../utils/')||id.startsWith('../services/')||id.startsWith('../context/'))return empty;
   return req(id);
  },React);
 return exports;
}
const maintenance=load('components/WeightMaintenanceSummary');
const {ProgressView,ProfileGoalSummary}=load('pages/MemberPortalPage','\nexport { ProgressView, ProfileGoalSummary };');
const {CommunityCard}=load('pages/MemberCommunityPage','\nexport { CommunityCard };');
async function render(component:any,props:any){let tree:any;await act(async()=>{tree=create(React.createElement(component,props));});trees.push(tree);return tree;}
const visible=(node:any):string=>node==null?'':Array.isArray(node)?node.map(visible).join(''):typeof node==='object'?visible(node.children):String(node);
const text=(tree:any)=>visible(tree.toJSON());
afterEach(async()=>{await act(async()=>trees.splice(0).forEach(t=>t.unmount()));});
const progress=(goal:any)=>({goal,weights:[],totalAttendances:0,attendanceByMonth:[],attendanceByWeek:[],motivation:{tone:'neutral',title:'Avanza',message:''}});
const props=(goal:any)=>({range:{label:'Noviembre',today:'2026-11-03'},days:[],firstOffset:0,attendances:[],progress:progress(goal),progressLoading:false,onRecordWeight:vi.fn()});
const member=(goal:any)=>({id:'m',name:'Atleta',currentStreak:null,longestStreak:null,monthlyAttendances:null,
 goalType:goal.goalType,progressPercent:goal.progressPercent,weightMaintenance:goal.maintenance,reactions:{love:0,mine:null}});
describe('FIT-MEMBER-010 real presentation components',()=>{
 it('FIT-MEMBER-011 summary does not derive endpoints from the visible history',async()=>{
  const goal={goalType:'lose_weight',initialWeightKg:90,currentWeightKg:84,targetWeightKg:80,progressPercent:60,maintenance:null};
  const p=props(goal);
  (p.progress.weights as any[]) .push({id:'bounded',weightKg:85,measuredOn:'2026-11-01',source:'member'});
  for(const tree of [await render(ProgressView,p),await render(ProfileGoalSummary,{progress:p.progress})]){
   expect(text(tree)).toContain('90 kg');expect(text(tree)).toContain('84 kg');expect(text(tree)).toContain('60%');
  }
 });
 it('FIT-MEMBER-011 weight upsert retains all dependent cache invalidations and explicit current prefill',()=>{
  const source=readFileSync(new URL('../../frontend/src/pages/MemberPortalPage.tsx',import.meta.url),'utf8');
  const mutation=source.slice(source.indexOf('const recordWeight ='),source.indexOf('const recordWeight =')+650);
  expect(mutation).toContain("refreshMemberQueries(queryClient, queryContext, 'weight')");
  expect(source).toContain('String(progress.data.currentWeightKg)');
  expect(source).not.toContain('progress.data?.weights.at(-1)');
 });
 it.each(['lose_weight','gain_weight'])('%s uses server percentage in Progress, Profile and Community',async goalType=>{
  const goal={goalType,initialWeightKg:90,currentWeightKg:85,targetWeightKg:80,progressPercent:50,maintenance:null};
  for(const tree of [await render(ProgressView,props(goal)),await render(ProfileGoalSummary,{progress:progress(goal)}),await render(CommunityCard,{member:member(goal),pending:false,onReact:noop})]){
   expect(text(tree)).toContain('50%');expect(text(tree)).not.toContain('NaN');
  }
 });
 it.each([[85,0,'En tu peso objetivo'],[86.2,1.2,'1,2 kg por encima del objetivo'],[84.2,-0.8,'0,8 kg por debajo del objetivo']])('maintenance %s never renders percentage',async(current,difference,label)=>{
  const goal={goalType:'maintain_weight',initialWeightKg:85,currentWeightKg:current,targetWeightKg:85,progressPercent:null,
    maintenance:{currentWeightKg:current,targetWeightKg:85,differenceKg:difference}};
  const p=await render(ProgressView,props(goal));
  const profile=await render(ProfileGoalSummary,{profile:{goal_type:'maintain_weight'},progress:progress(goal)});
  const community=await render(CommunityCard,{member:member(goal),pending:false,onReact:noop});
  for(const tree of [p,profile,community]){
   expect(text(tree)).toContain(label);expect(text(tree)).toContain('Objetivo: 85 kg');
   expect(text(tree)).not.toMatch(/(?:NaN|0|100|null)%/);
   expect(tree.root.findAll((n:any)=>n.props.role==='progressbar'||n.type==='progress')).toHaveLength(0);
  }
  const button=p.root.findAllByType('button').find((n:any)=>n.props.children==='Registrar peso');
  expect(button).toBeDefined();
 });
 it('null and hidden metrics do not become zero',async()=>{
  const tree=await render(CommunityCard,{member:member({goalType:null,progressPercent:null,maintenance:null}),pending:false,onReact:noop});
  expect(text(tree)).not.toContain('%');expect(text(tree)).not.toContain('kg');
 });
 it('zero and completed percentage remain visible when defined',async()=>{
  for(const percent of [0,100]){
   const tree=await render(ProgressView,props({goalType:'lose_weight',initialWeightKg:90,currentWeightKg:85,targetWeightKg:80,progressPercent:percent}));
   expect(text(tree)).toContain(percent+'% de avance');
   expect(tree.root.findByProps({role:'progressbar'}).props['aria-valuenow']).toBe(percent);
  }
 });
 it('missing history has a controlled empty state',async()=>{
  const tree=await render(ProgressView,props(null));
  expect(text(tree)).toContain('Sin progreso calculable');expect(text(tree)).not.toContain('NaN');
 });
});
