import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {Request,Response} from 'express';
const mock=vi.hoisted(()=>({from:vi.fn(),rpc:vi.fn(),signAvatar:vi.fn()}));
vi.mock('../src/config/supabase.js',()=>({supabaseAdmin:mock}));
vi.mock('../src/services/memberProfile.service.js',()=>({signAvatarUrl:mock.signAvatar}));
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
 it('valida el filtro antes de consultar datos',async()=>{
  const request=req();request.query={filter:'other-gym'};
  await expect(listMyFriendships(request,res())).rejects.toMatchObject({statusCode:400});expect(mock.from).not.toHaveBeenCalled();
 });
 it('filtra y pagina solicitudes, cuenta cada grupo y no firma fotos ocultas',async()=>{
  const chains:Array<{table:string;q:Record<string,ReturnType<typeof vi.fn>>}>=[];
  mock.from.mockImplementation((table:string)=>{
   const q:Record<string,ReturnType<typeof vi.fn>>={};
   for(const method of ['select','eq','neq','or','in','order','range'])q[method]=vi.fn().mockImplementation(()=>q);
   const result=()=>{
    if(table==='member_friend_preferences')return {data:{allow_requests:true},error:null};
    if(table==='gym_users')return {data:[{id:b,profiles:{full_name:'Amigo',avatar_url:'private/path'}}],error:null};
    if(table==='member_fitness_profiles')return {data:[{member_user_id:b,show_profile_photo:false}],error:null};
    if(q.select.mock.calls[0]?.[1]?.head)return {data:null,error:null,count:q.eq.mock.calls.some(([key,value])=>key==='status'&&value==='accepted')?27:q.neq.mock.calls.length?3:2};
    return {data:[{id:'friendship',member_a:a,member_b:b,requested_by:b,status:'pending'}],count:3,error:null};
   };
   q.maybeSingle=vi.fn().mockImplementation(async()=>result());
   q.then=vi.fn().mockImplementation((resolve,reject)=>Promise.resolve(result()).then(resolve,reject));
   chains.push({table,q});return q;
  });
  const request=req();request.query={filter:'incoming',page:'1'};const response=res();await listMyFriendships(request,response);
  const rows=chains[0].q;expect(rows.eq).toHaveBeenCalledWith('gym_id',g);expect(rows.eq).toHaveBeenCalledWith('status','pending');expect(rows.neq).toHaveBeenCalledWith('requested_by',a);expect(rows.range).toHaveBeenCalledWith(25,49);
  for(const {q,table} of chains.filter(item=>item.table==='member_friendships')){expect(table).toBe('member_friendships');expect(q.eq).toHaveBeenCalledWith('gym_id',g);expect(q.or).toHaveBeenCalledWith(`member_a.eq.${a},member_b.eq.${a}`);}
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({counts:{friends:27,incoming:3,outgoing:2},relationships:[expect.objectContaining({targetId:b,name:'Amigo',avatarUrl:null,viewable:true})]}));
  expect(mock.signAvatar).not.toHaveBeenCalled();
 });
});
