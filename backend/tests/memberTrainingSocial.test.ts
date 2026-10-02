import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Request,Response} from 'express';
const mock=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn()}));
vi.mock('../src/config/supabase.js',()=>({supabaseAdmin:mock}));
import {trainingSocialSchema,changeTrainingSocial,savePokePreferences,getMyTrainingSocial} from '../src/controllers/memberTrainingSocial.controller.js';
const g='00000000-0000-4000-8000-000000000001',a='00000000-0000-4000-8000-000000000002',b='00000000-0000-4000-8000-000000000003';
const req=(body:object={},role='member')=>({body,tenant:{gymId:g,gymUserId:a,role}}) as unknown as Request;
const res=()=>({json:vi.fn(),setHeader:vi.fn()}) as unknown as Response;
describe('toques y rachas seguras',()=>{
 beforeEach(()=>vi.clearAllMocks());
 it('no acepta asistencias, puntos, actor ni metas enviados por el cliente',()=>{
  expect(trainingSocialSchema.safeParse({targetMemberId:b,action:'accept',weeks:99}).success).toBe(false);
  expect(trainingSocialSchema.safeParse({targetMemberId:b,action:'poke',actor:b}).success).toBe(false);
 });
 it('deriva actor y gimnasio de la sesión',async()=>{
  mock.rpc.mockResolvedValue({error:null});await changeTrainingSocial(req({targetMemberId:b,action:'poke'}),res());
  expect(mock.rpc).toHaveBeenCalledWith('member_training_social_backend',{g,actor:a,target:b,action:'poke'});
 });
 it('impide acciones del owner y consentimiento ajeno',async()=>{
  await expect(changeTrainingSocial(req({targetMemberId:b,action:'accept'},'owner'),res())).rejects.toMatchObject({statusCode:403});
  await expect(savePokePreferences(req({allowPokes:true,memberId:b}),res())).rejects.toMatchObject({statusCode:400});expect(mock.rpc).not.toHaveBeenCalled();
 });
 it('no rompe el portal antes de ejecutar la migración',async()=>{
  const q={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({error:{code:'PGRST205',message:'missing'}})};mock.from.mockReturnValue(q);
  const response=res();await getMyTrainingSocial(req(),response);expect(response.json).toHaveBeenCalledWith({available:false});expect(q.eq).toHaveBeenCalledWith('member_user_id',a);expect(mock.rpc).not.toHaveBeenCalled();
 });
});
