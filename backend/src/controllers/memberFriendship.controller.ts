import type { Request,Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { signAvatarUrl } from '../services/memberProfile.service.js';

export const friendshipActionSchema=z.object({targetMemberId:z.string().uuid(),action:z.enum(['request','accept','reject','cancel','remove'])}).strict();
function member(req:Request){if(req.tenant!.role!=='member')throw new AppError(403,'MEMBER_REQUIRED','Solo disponible para miembros.');}
function parse<T extends z.ZodTypeAny>(schema:T,value:unknown):z.output<T>{const r=schema.safeParse(value);if(!r.success)throw new AppError(400,'INVALID_FRIEND_INPUT','Revisa los datos de la solicitud.');return r.data;}
function missing(error:{code?:string}|null){return error?.code==='42P01'||error?.code==='PGRST205';}
function check(error:{message:string;code?:string}|null){if(error)throw fromSupabaseError(error);}
function context(req:Request){return {g:req.tenant!.gymId,actor:req.tenant!.gymUserId};}
export async function listMyFriendships(req:Request,res:Response){
 member(req);res.setHeader('Cache-Control','no-store');const {g,actor}=context(req);
 const page=parse(z.coerce.number().int().min(0).max(10000),req.query.page??0);
 const filter=parse(z.enum(['all','friends','incoming','outgoing']),req.query.filter??'all');
 const scoped=()=>supabaseAdmin.from('member_friendships').select('id',{count:'exact',head:true}).eq('gym_id',g).or(`member_a.eq.${actor},member_b.eq.${actor}`);
 let rows=supabaseAdmin.from('member_friendships').select('id,member_a,member_b,requested_by,status,updated_at',{count:'exact'})
 .eq('gym_id',g).or(`member_a.eq.${actor},member_b.eq.${actor}`).in('status',['pending','accepted']);
 if(filter==='friends')rows=rows.eq('status','accepted');
 if(filter==='incoming')rows=rows.eq('status','pending').neq('requested_by',actor);
 if(filter==='outgoing')rows=rows.eq('status','pending').eq('requested_by',actor);
 const result=await rows.order('updated_at',{ascending:false}).range(page*25,page*25+24);
 if(missing(result.error)){res.json({available:false,relationships:[],total:0,allowRequests:false});return;}check(result.error);
 const preference=await supabaseAdmin.from('member_friend_preferences').select('allow_requests').eq('gym_id',g).eq('member_user_id',actor).maybeSingle();check(preference.error);
 const [friends,incoming,outgoing]=await Promise.all([scoped().eq('status','accepted'),scoped().eq('status','pending').neq('requested_by',actor),scoped().eq('status','pending').eq('requested_by',actor)]);
 for(const count of [friends,incoming,outgoing])check(count.error);
 const ids=(result.data??[]).map(r=>r.member_a===actor?r.member_b:r.member_a);
 const users=ids.length?await supabaseAdmin.from('gym_users').select('id,profiles(full_name,avatar_url)').eq('gym_id',g).eq('status','active').eq('role','member').eq('account_mode','portal').in('id',ids):{data:[],error:null};check(users.error);
 const visible=ids.length?await supabaseAdmin.from('member_fitness_profiles').select('member_user_id,show_profile_photo').eq('gym_id',g).eq('show_in_community',true).in('member_user_id',ids):{data:[],error:null};check(visible.error);
 const names=new Map((users.data??[]).map(u=>[u.id,(Array.isArray(u.profiles)?u.profiles[0]:u.profiles)?.full_name??'Miembro']));const visibleIds=new Set((visible.data??[]).map(p=>p.member_user_id));
 const relationships=await Promise.all((result.data??[]).map(async r=>{const targetId=r.member_a===actor?r.member_b:r.member_a;const viewable=names.has(targetId)&&visibleIds.has(targetId);const user=users.data?.find(u=>u.id===targetId);const profile=user&&(Array.isArray(user.profiles)?user.profiles[0]:user.profiles);const showPhoto=viewable&&visible.data?.some(p=>p.member_user_id===targetId&&p.show_profile_photo);return {id:r.id,targetId,name:viewable?names.get(targetId):'Perfil no disponible',avatarUrl:showPhoto?await signAvatarUrl(profile?.avatar_url):null,viewable,status:r.status,direction:r.requested_by===actor?'outgoing':'incoming'};}));
 res.json({available:true,allowRequests:preference.data?.allow_requests??false,total:result.count??0,counts:{friends:friends.count??0,incoming:incoming.count??0,outgoing:outgoing.count??0},relationships});
}
export async function getMemberFriendship(req:Request,res:Response){
 member(req);res.setHeader('Cache-Control','no-store');const {g,actor}=context(req);const target=parse(z.string().uuid(),req.params.memberId);
 if(target===actor)throw new AppError(400,'FRIEND_SELF_NOT_ALLOWED','No puedes enviarte una solicitud.');
 const r=await supabaseAdmin.from('member_friendships').select('status,requested_by').eq('gym_id',g).eq('member_a',actor<target?actor:target).eq('member_b',actor<target?target:actor).maybeSingle();
 if(missing(r.error)){res.json({available:false});return;}check(r.error);
 const [preferences,visible,users]=await Promise.all([
  supabaseAdmin.from('member_friend_preferences').select('member_user_id,allow_requests').eq('gym_id',g).in('member_user_id',[actor,target]),
  supabaseAdmin.from('member_fitness_profiles').select('member_user_id').eq('gym_id',g).eq('show_in_community',true).in('member_user_id',[actor,target]),
  supabaseAdmin.from('gym_users').select('id').eq('gym_id',g).eq('role','member').eq('status','active').eq('account_mode','portal').in('id',[actor,target]),
 ]);for(const result of [preferences,visible,users])check(result.error);
 if(!users.data?.some(u=>u.id===target)||!visible.data?.some(p=>p.member_user_id===target))throw new AppError(404,'PROFILE_NOT_AVAILABLE','Este perfil no está disponible.');
 res.json({available:true,canRequest:preferences.data?.filter(p=>p.allow_requests).length===2&&visible.data?.length===2,status:r.data?.status??'none',direction:r.data?.requested_by===actor?'outgoing':'incoming'});
}
export async function changeMemberFriendship(req:Request,res:Response){
 member(req);const input=parse(friendshipActionSchema,req.body);
 const r=await supabaseAdmin.rpc('change_member_friendship_backend',{...context(req),target:input.targetMemberId,action:input.action});
 if(missing(r.error))throw new AppError(503,'FRIEND_FEATURE_UNAVAILABLE','Las amistades todavía no están habilitadas.');check(r.error);res.json({saved:true});
}
export async function saveMyFriendPreferences(req:Request,res:Response){
 member(req);const input=parse(z.object({allowRequests:z.boolean()}).strict(),req.body);
 const r=await supabaseAdmin.rpc('set_member_friend_preferences_backend',{...context(req),allow_requests:input.allowRequests});check(r.error);res.json({saved:true});
}
