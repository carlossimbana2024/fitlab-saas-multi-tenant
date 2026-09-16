import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { env } from '../config/env.js';
import { AppError } from '../errors/AppError.js';
import { cookieBase } from './auth.controller.js';
import { paymentProofHash } from '../security/paymentProof.js';

const bucket = 'saas-payment-proofs';
const idSchema = z.string().uuid();
const reviewSchema = z.object({ decision: z.enum(['approved','rejected']), reason: z.string().trim().min(3).max(500) });
function failure(error: { message: string; code?: string } | null) {
  if (!error) return;
  if (error.code === '23505') throw new AppError(409,'DUPLICATE_PROOF','El comprobante o referencia ya fue registrado.');
  throw new AppError(409,'BILLING_OPERATION_FAILED','No se pudo completar la operación. Comprueba el estado de la solicitud y la suscripción.');
}
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result=schema.safeParse(value);
  if (!result.success) throw new AppError(400,'INVALID_BILLING_INPUT','Revisa los datos de la solicitud.');
  return result.data as z.output<T>;
}
function owner(request: Request) {
  if (request.tenant?.role !== 'owner') throw new AppError(403,'OWNER_REQUIRED','Solo el dueño puede gestionar el pago del plan.');
}
export async function platformAccess(request: Request, response: Response) {
  const {data,error} = await request.supabase!.rpc('platform_billing_access');
  failure(error);
  response.setHeader('Cache-Control','no-store');
  response.json({ authorized: data?.authorized === true, verified: data?.verified === true });
}
export async function requirePlatform(request: Request, verified = true) {
  const {data,error} = await request.supabase!.rpc('platform_billing_access');
  if (error || data?.authorized !== true) throw new AppError(403,'PLATFORM_ADMIN_REQUIRED','Acceso exclusivo del administrador de FitLab.');
  if (verified && data?.verified !== true) throw new AppError(403,'PLATFORM_MFA_REQUIRED','Confirma tu código de verificación en dos pasos.');
}
async function authCall(request: Request, path: string, body: object) {
  const result = await fetch(`${env.SUPABASE_URL}/auth/v1/${path}`, {method:'POST',headers:{apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${request.accessToken}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  if (!result.ok) throw new AppError(400,'MFA_VERIFICATION_FAILED','No se pudo verificar el código o preparar el autenticador.');
  return result.json();
}
export async function setupMfa(request: Request, response: Response) {
  await requirePlatform(request,false);
  response.setHeader('Cache-Control','no-store');
  const existing = request.authUser!.factors?.find(f => f.factor_type==='totp' && f.status==='verified');
  if (existing) { response.json({factorId:existing.id}); return; }
  // Reuse unfinished setup instead of filling the user's factor quota.
  for (const factor of request.authUser!.factors ?? []) {
    if (factor.factor_type==='totp' && factor.status==='unverified') {
      const result = await fetch(`${env.SUPABASE_URL}/auth/v1/factors/${factor.id}`,{method:'DELETE',headers:{apikey:env.SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${request.accessToken}`}});
      if (!result.ok) throw new AppError(400,'MFA_SETUP_FAILED','No se pudo reiniciar la configuración.');
    }
  }
  const data = await authCall(request,'factors',{factor_type:'totp',friendly_name:'Administración FitLab',issuer:'FitLab'});
  response.json({factorId:data.id,uri:data.totp.uri});
}
export async function verifyMfa(request: Request, response: Response) {
  await requirePlatform(request,false);
  const input = parse(z.object({factorId:idSchema,code:z.string().regex(/^\d{6}$/)}),request.body);
  const challenge = await authCall(request,`factors/${input.factorId}/challenge`,{});
  const session = await authCall(request,`factors/${input.factorId}/verify`,{challenge_id:challenge.id,code:input.code});
  response.cookie('fitlab_access_token',session.access_token,{...cookieBase,maxAge:session.expires_in*1000});
  response.cookie('fitlab_refresh_token',session.refresh_token,{...cookieBase,maxAge:30*86400000});
  response.setHeader('Cache-Control','no-store');
  response.json({verified:true});
}
export async function listOwnRequests(request: Request,response: Response) {
  owner(request);
  const {data,error} = await supabaseAdmin.from('saas_payment_requests').select('id,amount,currency,status,created_at,review_reason,bank_reference').eq('gym_id',request.tenant!.gymId).order('created_at',{ascending:false}).limit(100);
  failure(error);
  let qrUrl:string|null=null;
  if(env.MANUAL_BILLING_QR_PATH.trim()){
    const signed=await supabaseAdmin.storage.from('saas-billing-assets').createSignedUrl(env.MANUAL_BILLING_QR_PATH,600);
    failure(signed.error); qrUrl=signed.data!.signedUrl;
  }
  response.json({requests:data,instructions:env.MANUAL_BILLING_INSTRUCTIONS,qrUrl});
}
export async function prepareProof(request: Request,response: Response) {
  owner(request);
  if (!env.MANUAL_BILLING_INSTRUCTIONS.trim()) throw new AppError(409,'BILLING_NOT_CONFIGURED','FitLab todavía no ha configurado los datos de transferencia.');
  const {data,error} = await supabaseAdmin.rpc('prepare_saas_payment_request',{target_gym:request.tenant!.gymId,actor:request.authUser!.id});
  failure(error);
  if (data.status !== 'draft') throw new AppError(409,'REVIEW_PENDING','Ya tienes un comprobante pendiente de revisión.');
  const upload = await supabaseAdmin.storage.from(bucket).createSignedUploadUrl(data.proof_path,{upsert:true});
  failure(upload.error);
  response.json({id:data.id,signedUrl:upload.data!.signedUrl});
}
export async function submitProof(request: Request,response: Response) {
  owner(request);
  const id = parse(idSchema,request.params.id);
  const input = parse(z.object({reference:z.string().trim().min(4).max(120),payer:z.string().trim().min(2).max(150),paidOn:z.string().date()}),request.body);
  const {data:req,error} = await supabaseAdmin.from('saas_payment_requests').select('proof_path,status,submitted_by').eq('id',id).eq('gym_id',request.tenant!.gymId).maybeSingle();
  failure(error);
  if (!req || req.submitted_by!==request.authUser!.id) throw new AppError(404,'REQUEST_NOT_FOUND','Solicitud no encontrada.');
  const file = await supabaseAdmin.storage.from(bucket).download(req.proof_path);
  if (file.error || !file.data) throw new AppError(400,'PROOF_MISSING','Primero sube el comprobante.');
  const hash = paymentProofHash(Buffer.from(await file.data.arrayBuffer()));
  if (!hash) throw new AppError(400,'INVALID_PROOF','Utiliza un PDF, JPG o PNG de hasta 5 MB.');
  const result = await supabaseAdmin.rpc('submit_saas_payment_request',{target_id:id,target_gym:request.tenant!.gymId,actor:request.authUser!.id,supplied_hash:hash,supplied_reference:input.reference,supplied_name:input.payer,supplied_date:input.paidOn});
  failure(result.error); response.json({submitted:true});
}
export async function listPlatformRequests(request: Request,response: Response) {
  await requirePlatform(request);
  const {status,page} = parse(z.object({status:z.enum(['pending','approved','rejected','draft','all']).default('pending'),page:z.coerce.number().int().min(0).max(10000).default(0)}),request.query);
  let query = supabaseAdmin.from('saas_payment_requests').select('id,gym_id,subscription_id,amount,currency,status,payer_name,bank_reference,paid_on,created_at,reviewed_at,review_reason,gyms(name),gym_subscriptions(plan_name_snapshot,status,current_period_ends_at)',{count:'exact'}).order('created_at',{ascending:false}).order('id').range(page*25,page*25+24);
  if (status!=='all') query=query.eq('status',status);
  const {data,error,count} = await query; failure(error); response.json({requests:data,total:count});
}
export async function downloadProof(request: Request,response: Response) {
  await requirePlatform(request);
  const id=parse(idSchema,request.params.id);
  const {data,error} = await supabaseAdmin.from('saas_payment_requests').select('proof_path,gym_id,status').eq('id',id).maybeSingle();
  failure(error);
  if (!data || data.status==='draft') throw new AppError(404,'PROOF_NOT_FOUND','Comprobante no disponible.');
  const signed = await supabaseAdmin.storage.from(bucket).createSignedUrl(data.proof_path,60,{download:true});
  failure(signed.error);
  const audit = await supabaseAdmin.from('audit_logs').insert({gym_id:data.gym_id,actor_profile_id:request.authUser!.id,action:'saas.proof_viewed',entity_type:'saas_payment_request',entity_id:id});
  failure(audit.error); response.json({url:signed.data!.signedUrl});
}
export async function reviewProof(request: Request,response: Response) {
  await requirePlatform(request);
  const input=parse(reviewSchema,request.body);
  const {error}=await request.supabase!.rpc('review_saas_payment_request',{target_id:parse(idSchema,request.params.id),decision:input.decision,reason:input.reason});
  failure(error); response.json({reviewed:true});
}
export async function suspendSubscription(request: Request,response: Response) {
  await requirePlatform(request);
  const input=parse(z.object({reason:z.string().trim().min(3).max(500)}),request.body);
  const {error}=await request.supabase!.rpc('suspend_manual_saas_subscription',{target_id:parse(idSchema,request.params.id),reason:input.reason});
  failure(error); response.json({suspended:true});
}
