import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { signAvatarUrl, avatarExtension } from '../services/memberProfile.service.js';
import { paymentProofMimeType } from '../security/paymentProof.js';
import { dateInTimezone } from '../utils/gymDate.js';
import { goalProgress } from './memberCommunity.controller.js';

export const socialProfileSchema=z.object({bio:z.string().trim().max(160),showGallery:z.boolean(),showBadges:z.boolean()}).partial().strict().refine(input=>Object.values(input).some(value=>value!==undefined),'Indica el cambio a guardar.');
export const galleryChangeSchema=z.object({slot:z.number().int().min(0).max(2),path:z.string().max(300).nullable()}).strict();
const bucket='member-gallery';
function member(request:Request) { if(request.tenant?.role!=='member') throw new AppError(403,'MEMBER_ONLY_ENDPOINT','Solo disponible para miembros.'); }
function parse<T extends z.ZodTypeAny>(schema:T,value:unknown):z.output<T> {const result=schema.safeParse(value);if(!result.success)throw new AppError(400,'INVALID_SOCIAL_PROFILE','Revisa los datos del perfil.');return result.data;}
function check(error:{message:string;code?:string}|null) {if(error)throw fromSupabaseError(error);}
export function galleryPathOwned(path:string,gym:string,actor:string) {return path.startsWith(`${gym}/${actor}/`)&&/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/.test(path);}
export function galleryImageMime(bytes:Buffer) {return paymentProofMimeType(bytes)?.startsWith('image/')?paymentProofMimeType(bytes):bytes.length>=12&&bytes.length<=5242880&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;}

export async function getMemberSocialProfile(request:Request,response:Response) {
 member(request); const g=request.tenant!.gymId;const actor=request.tenant!.gymUserId;
 const target=request.params.memberId?parse(z.string().uuid(),request.params.memberId):actor;
 const own=target===actor;
 const [user,fitness,social]=await Promise.all([
  supabaseAdmin.from('gym_users').select('id,profiles(full_name,avatar_url)').eq('gym_id',g).eq('id',target).eq('role','member').eq('status','active').eq('account_mode','portal').maybeSingle(),
  supabaseAdmin.from('member_fitness_profiles').select('show_in_community,show_profile_photo,show_streak,show_attendance_count,show_goal,goal_type,public_message,show_weight_progress,weight_kg,target_weight_kg').eq('gym_id',g).eq('member_user_id',target).maybeSingle(),
  supabaseAdmin.from('member_social_profiles').select('bio,gallery_paths,show_gallery,show_badges').eq('gym_id',g).eq('member_user_id',target).maybeSingle(),
 ]);for(const r of [user,fitness,social])check(r.error);
 if(!user.data||(!own&&!fitness.data?.show_in_community))throw new AppError(404,'PROFILE_NOT_AVAILABLE','Este perfil no está disponible.');
 const showBadges=own||social.data?.show_badges;
 const showStreak=own||fitness.data?.show_streak;
 const showAttendance=own||fitness.data?.show_attendance_count;
 const today=dateInTimezone(request.tenant!.timezone);
 const [badges,streak,attendance,reactions,mine,weight]=await Promise.all([
  showBadges?supabaseAdmin.from('member_badges').select('badge_code,earned_at,loyalty_badges(name,description)').eq('gym_id',g).eq('member_user_id',target).eq('valid',true):Promise.resolve({data:[],error:null}),
  showStreak?supabaseAdmin.from('user_streaks').select('current_streak,longest_streak').eq('gym_id',g).eq('member_user_id',target).maybeSingle():Promise.resolve({data:null,error:null}),
  showAttendance?supabaseAdmin.from('attendances').select('id',{count:'exact',head:true}).eq('gym_id',g).eq('member_user_id',target).eq('status','valid').gte('attendance_date',today.slice(0,7)+'-01').lte('attendance_date',today):Promise.resolve({count:null,error:null}),
  supabaseAdmin.from('member_community_reactions').select('id',{count:'exact',head:true}).eq('gym_id',g).eq('target_member_user_id',target).eq('reaction_type','love'),
  supabaseAdmin.from('member_community_reactions').select('reaction_type').eq('gym_id',g).eq('target_member_user_id',target).eq('actor_member_user_id',actor).maybeSingle(),
  (own||fitness.data?.show_weight_progress)&&fitness.data?supabaseAdmin.from('member_weight_entries').select('weight_kg').eq('gym_id',g).eq('member_user_id',target).order('measured_on',{ascending:false}).limit(1).maybeSingle():Promise.resolve({data:null,error:null}),
 ]);for(const r of [badges,streak,attendance,reactions,mine,weight])check(r.error);
 const profile=Array.isArray(user.data.profiles)?user.data.profiles[0]:user.data.profiles;
 const paths=own||social.data?.show_gallery?social.data?.gallery_paths??[null,null,null]:[null,null,null];
 const gallery=await Promise.all(paths.map(async(path:string|null)=>{
  if(!path||!galleryPathOwned(path,g,target))return null;
  const signed=await supabaseAdmin.storage.from(bucket).createSignedUrl(path,300);return signed.data?.signedUrl??null;
 }));
 response.setHeader('Cache-Control','no-store');response.json({profile:{id:target,own,name:profile?.full_name??'Miembro',
 avatarUrl:own||fitness.data?.show_profile_photo?await signAvatarUrl(profile?.avatar_url):null,
 bio:social.data?.bio??fitness.data?.public_message??'',gallery,communityVisible:Boolean(fitness.data?.show_in_community),
 showGallery:social.data?.show_gallery??false,showBadges:social.data?.show_badges??false,
 goalType:own||fitness.data?.show_goal?fitness.data?.goal_type??null:null,
 progressPercent:(own||fitness.data?.show_weight_progress)&&fitness.data?goalProgress(fitness.data,Number(weight.data?.weight_kg??fitness.data.weight_kg)):null,
 streak:streak.data,monthlyAttendances:attendance.count,badges:badges.data,
 loveCount:reactions.count??0,loved:mine.data?.reaction_type==='love'}});
}
export async function updateMySocialProfile(request:Request,response:Response) {
 member(request);const input=parse(socialProfileSchema,request.body);
 const r=await supabaseAdmin.rpc('update_member_social_profile_backend',{g:request.tenant!.gymId,actor:request.tenant!.gymUserId,input});check(r.error);response.json({saved:true});
}
export async function prepareMyGalleryPhoto(request:Request,response:Response) {
 member(request);const input=parse(z.object({contentType:z.enum(['image/jpeg','image/png','image/webp'])}).strict(),request.body);
 const path=`${request.tenant!.gymId}/${request.tenant!.gymUserId}/${crypto.randomUUID()}.${avatarExtension(input.contentType)}`;
 const upload=await supabaseAdmin.storage.from(bucket).createSignedUploadUrl(path,{upsert:false});check(upload.error);response.json({upload:upload.data});
}
export async function changeMyGalleryPhoto(request:Request,response:Response) {
 member(request);const input=parse(galleryChangeSchema,request.body);const g=request.tenant!.gymId;const actor=request.tenant!.gymUserId;
 if(input.path){
  if(!galleryPathOwned(input.path,g,actor))throw new AppError(400,'INVALID_SOCIAL_PHOTO','La foto no pertenece a tu perfil.');
  const file=await supabaseAdmin.storage.from(bucket).download(input.path);
  if(file.error||!file.data||file.data.size>5242880)throw new AppError(400,'INVALID_SOCIAL_PHOTO','No se encontró una imagen válida de hasta 5 MB.');
  const mime=galleryImageMime(Buffer.from(await file.data.arrayBuffer()));
  if(!mime||mime!==file.data.type||!input.path.endsWith(`.${avatarExtension(mime)}`))throw new AppError(400,'INVALID_SOCIAL_PHOTO','El contenido de la imagen no coincide con su formato.');
 }
 const r=await supabaseAdmin.rpc('update_member_social_profile_backend',{g,actor,input});check(r.error);response.json({saved:true});
}
