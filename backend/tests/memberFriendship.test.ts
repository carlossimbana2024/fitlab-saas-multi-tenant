import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Request,Response} from 'express';
const mock=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn()}));
vi.mock('../src/config/supabase.js',()=>({supabaseAdmin:mock}));
import {friendshipActionSchema,changeMemberFriendship,listMyFriendships,saveMyFriendPreferences} from '../src/controllers/memberFriendship.controller.js';
const g='00000000-0000-4000-8000-000000000001',a='00000000-0000-4000-8000-000000000002',b='00000000-0000-4000-8000-000000000003';
const req=(body:object={},role='member')=>({body,query:{},tenant:{gymId:g,gymUserId:a,role}}) as unknown as Request;
const res=()=>({json:vi.fn(),setHeader:vi.fn()}) as unknown as Response;
describe('amistades tenant-scoped',()=>{
 beforeEach(()=>vi.clearAllMocks());
 it('no admite actor o gimnasio enviados por el cliente ni acciones desconocidas',()=>{
  expect(friendshipActionSchema.safeParse({targetMemberId:b,action:'accept',actor:b}).success).toBe(false);
  expect(friendshipActionSchema.safeParse({targetMemberId:b,action:'force-accept'}).success).toBe(false);
 });
 it('usa exclusivamente gimnasio y actor de la sesión',async()=>{
  mock.rpc.mockResolvedValue({data:{},error:null});await changeMemberFriendship(req({targetMemberId:b,action:'request'}),res());
  expect(mock.rpc).toHaveBeenCalledWith('change_member_friendship_backend',{g,actor:a,target:b,action:'request'});
 });
 it('owner no puede actuar como miembro',async()=>{
  await expect(changeMemberFriendship(req({targetMemberId:b,action:'accept'},'owner'),res())).rejects.toMatchObject({statusCode:403});expect(mock.rpc).not.toHaveBeenCalled();
 });
 it('una migración pendiente no rompe el portal desplegado',async()=>{
  const q={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),or:vi.fn().mockReturnThis(),in:vi.fn().mockReturnThis(),order:vi.fn().mockReturnThis(),range:vi.fn().mockResolvedValue({error:{code:'PGRST205',message:'missing'}})};mock.from.mockReturnValue(q);
  const response=res();await listMyFriendships(req(),response);expect(response.json).toHaveBeenCalledWith({available:false,relationships:[],total:0,allowRequests:false});expect(q.eq).toHaveBeenCalledWith('gym_id',g);expect(q.or).toHaveBeenCalledWith(`member_a.eq.${a},member_b.eq.${a}`);
 });
 it('el consentimiento es explícito y no acepta datos extra',async()=>{
  await expect(saveMyFriendPreferences(req({allowRequests:true,memberId:b}),res())).rejects.toMatchObject({statusCode:400});expect(mock.rpc).not.toHaveBeenCalled();
 });
});
