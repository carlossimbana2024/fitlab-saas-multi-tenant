import type {Request,Response} from 'express';
import {z} from 'zod';
import {supabaseAdmin} from '../config/supabase.js';
import {AppError} from '../errors/AppError.js';
import {fromSupabaseError} from '../utils/supabaseError.js';
export const trainingSocialSchema=z.object({targetMemberId:z.string().uuid(),action:z.enum(['poke','invite','accept','reject','cancel','end'])}).strict();
function member(req:Request){if(req.tenant!.role!=='member')throw new AppError(403,'MEMBER_REQUIRED','Solo disponible para miembros.');}
function missing(e:{code?:string}|null){return ['PGRST202','PGRST205','42P01','42883'].includes(e?.code??'');}
function check(e:{message:string;code?:string}|null){if(e)throw fromSupabaseError(e);}
function context(req:Request){return {g:req.tenant!.gymId,actor:req.tenant!.gymUserId};}
export async function getMyTrainingSocial(req:Request,res:Response){
 member(req);res.setHeader('Cache-Control','no-store');const {g,actor}=context(req);
 const preferences=await supabaseAdmin.from('member_poke_preferences').select('allow_pokes').eq('gym_id',g).eq('member_user_id',actor).maybeSingle();
 if(missing(preferences.error)){res.json({available:false});return;}check(preferences.error);
 const progress=await supabaseAdmin.rpc('member_shared_streak_progress_backend',{g,actor});check(progress.error);
 const pokes=await supabaseAdmin.from('member_pokes').select('target,sent_at').eq('gym_id',g).eq('actor',actor).gte('sent_at',new Date(Date.now()-12*3600000).toISOString());check(pokes.error);
 res.json({available:true,allowPokes:preferences.data?.allow_pokes??false,streaks:progress.data??[],cooldowns:(pokes.data??[]).map(p=>({targetId:p.target,nextAt:new Date(Date.parse(p.sent_at)+12*3600000).toISOString()}))});
}
export async function changeTrainingSocial(req:Request,res:Response){
 member(req);const parsed=trainingSocialSchema.safeParse(req.body);if(!parsed.success)throw new AppError(400,'INVALID_TRAINING_INPUT','Revisa los datos de la acción.');
 const r=await supabaseAdmin.rpc('member_training_social_backend',{...context(req),target:parsed.data.targetMemberId,action:parsed.data.action});check(r.error);res.json({saved:true});
}
export async function savePokePreferences(req:Request,res:Response){
 member(req);const parsed=z.object({allowPokes:z.boolean()}).strict().safeParse(req.body);if(!parsed.success)throw new AppError(400,'INVALID_TRAINING_INPUT','Confirma si deseas recibir toques.');
 const r=await supabaseAdmin.rpc('member_training_social_backend',{...context(req),target:null,action:parsed.data.allowPokes?'allow':'disable'});check(r.error);res.json({saved:true});
}
