import type { Request, Response } from 'express';
import { z } from 'zod';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';
import { paymentProofHash, paymentProofMimeType } from '../security/paymentProof.js';
import { fromSupabaseError } from '../utils/supabaseError.js';
import { membershipPaymentSettingsSchema, prepareMembershipPaymentSchema, reviewMembershipPaymentSchema, submitMembershipPaymentSchema } from '../validators/membershipPaymentRequest.validator.js';

const bucket = 'membership-payment-proofs';
const requestFields = 'id,location_id,member_user_id,membership_id,plan_id,plan_snapshot,amount,currency,expires_at,status,channel,method,paid_on,reported_amount,reference,comment,review_reason,reviewed_at,payment_id,created_at,submitted_at';
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, 'INVALID_PAYMENT_REQUEST_INPUT', 'Revisa los datos de la solicitud.', result.error.flatten());
  return result.data;
}
function context(request: Request) { return { g: request.tenant!.gymId, actor: request.tenant!.gymUserId }; }
function member(request: Request) {
  if (request.tenant!.role !== 'member') throw new AppError(403, 'MEMBER_REQUIRED', 'Esta opción pertenece al portal del miembro.');
}
function owner(request: Request) {
  if (request.tenant!.role !== 'owner') throw new AppError(403, 'OWNER_REQUIRED', 'Solo el owner configura los pagos del gimnasio.');
}
function check(error: { message: string; code?: string } | null) {
  if (error) throw fromSupabaseError(error);
}
function noStore(response: Response) { response.setHeader('Cache-Control', 'no-store'); }

export async function getMyMembershipPayments(request: Request, response: Response) {
  member(request);
  const { g, actor } = context(request);
  const results = await Promise.all([
    supabaseAdmin.from('memberships').select('id,plan_id,status,price_at_purchase,currency,plans(id,name,price,currency,duration_unit,duration_value,is_active),membership_periods(starts_on,ends_on,status)')
      .eq('gym_id', g).eq('member_user_id', actor).neq('status', 'cancelled').order('created_at', { ascending: false }).limit(50),
    supabaseAdmin.from('membership_payment_requests').select(requestFields).eq('gym_id', g).eq('member_user_id', actor).order('created_at', { ascending: false }).limit(100),
    supabaseAdmin.from('member_payments').select('id,amount,currency,payment_method,status,paid_at,receipt_number,receipt_verification_token,membership_periods(starts_on,ends_on,status)')
      .eq('gym_id', g).eq('member_user_id', actor).not('membership_id', 'is', null).order('paid_at', { ascending: false }).limit(100),
    request.tenant!.defaultLocationId ? supabaseAdmin.from('membership_payment_settings').select('enabled,instructions,methods').eq('gym_id', g).eq('location_id', request.tenant!.defaultLocationId).maybeSingle() : Promise.resolve({ data: null, error: null }),
    supabaseAdmin.from('gyms').select('name,timezone,whatsapp_phone').eq('id', g).single(),
    request.tenant!.defaultLocationId ? supabaseAdmin.from('gym_locations').select('id,name,is_active,whatsapp_phone').eq('gym_id', g).eq('id', request.tenant!.defaultLocationId).maybeSingle() : Promise.resolve({ data: null, error: null }),
  ]);
  for (const result of results) check(result.error);
  const [memberships, requests, payments, settings, gym, location] = results;
  const current = memberships.data?.find((m) => m.status === 'active') ?? memberships.data?.[0];
  const plans = await supabaseAdmin.from('plans').select('id,name,price,currency,duration_unit,duration_value')
    .eq('gym_id', g).eq('is_active', true).gt('price', 0).order('name');
  check(plans.error);
  noStore(response);
  response.json({ memberships: memberships.data, requests: requests.data, payments: payments.data,
    plans: (plans.data ?? []).filter((p) => !current || p.id === current.plan_id),
    settings: location.data?.is_active && settings.data ? settings.data : { enabled: false, instructions: '', methods: [] },
    gym: { name: gym.data!.name, timezone: gym.data!.timezone }, location: location.data?.name ?? null,
    whatsappPhone: location.data?.whatsapp_phone?.trim() || gym.data!.whatsapp_phone || null,
  });
}

export async function getMembershipPaymentSettings(request: Request, response: Response) {
  owner(request);
  const { data, error } = await supabaseAdmin.from('membership_payment_settings').select('*').eq('gym_id', request.tenant!.gymId);
  check(error); noStore(response); response.json({ settings: data });
}
export async function saveMembershipPaymentSettings(request: Request, response: Response) {
  owner(request);
  const input = parse(membershipPaymentSettingsSchema, request.body);
  const { data, error } = await supabaseAdmin.rpc('save_membership_payment_settings_backend', { ...context(request), l: parse(z.string().uuid(), request.params.locationId), input });
  check(error); response.json({ settings: data });
}
export async function prepareMembershipPayment(request: Request, response: Response) {
  member(request);
  const input = parse(prepareMembershipPaymentSchema, request.body);
  const { data, error } = await supabaseAdmin.rpc('prepare_membership_payment_request_backend', { ...context(request), p: input.planId });
  check(error);
  let signedUrl: string | null = null;
  if (input.channel === 'fitlab') {
    const upload = await supabaseAdmin.storage.from(bucket).createSignedUploadUrl(data.proof_path, { upsert: false });
    check(upload.error); signedUrl = upload.data!.signedUrl;
  }
  noStore(response); response.json({ id: data.id, signedUrl, amount: data.amount, currency: data.currency, expiresAt: data.expires_at });
}
export async function submitMembershipPayment(request: Request, response: Response) {
  member(request);
  const input = parse(submitMembershipPaymentSchema, request.body);
  const id = parse(z.string().uuid(), request.params.id);
  const { data, error } = await supabaseAdmin.from('membership_payment_requests').select('proof_path,status').eq('gym_id', request.tenant!.gymId).eq('member_user_id', request.tenant!.gymUserId).eq('id', id).maybeSingle();
  check(error);
  if (!data || data.status !== 'draft') throw new AppError(409, 'PAYMENT_REQUEST_INVALID_STATE', 'La solicitud ya cambió de estado. Actualiza la pantalla.');
  let hash: string | null = null;
  if (input.channel === 'fitlab') {
    const file = await supabaseAdmin.storage.from(bucket).download(data.proof_path);
    if (file.error || !file.data || file.data.size > 5_242_880) throw new AppError(400, 'PROOF_MISSING', 'Sube un comprobante JPG, PNG o PDF de hasta 5 MB.');
    const bytes = Buffer.from(await file.data.arrayBuffer());
    hash = paymentProofHash(bytes);
    if (!hash || paymentProofMimeType(bytes) !== file.data.type) throw new AppError(400, 'INVALID_PROOF', 'El archivo no es un JPG, PNG o PDF válido o no coincide con su formato declarado.');
  }
  const result = await supabaseAdmin.rpc('submit_membership_payment_request_backend', { ...context(request), r: id, input, hash, expected_path: data.proof_path });
  check(result.error); noStore(response); response.json({ submitted: true });
}
export async function listMembershipPaymentRequests(request: Request, response: Response) {
  const input = parse(z.object({ status: z.enum(['pending', 'all']).default('pending'), page: z.coerce.number().int().min(0).max(10000).default(0) }), request.query);
  let query = supabaseAdmin.from('membership_payment_requests').select(requestFields, { count: 'exact' }).eq('gym_id', request.tenant!.gymId)
    .neq('status', 'draft').order('created_at', { ascending: false }).order('id').range(input.page * 25, input.page * 25 + 24);
  if (input.status === 'pending') query = query.eq('status', 'pending');
  const result = await query; check(result.error);
  const ids = [...new Set((result.data ?? []).map((r) => r.member_user_id))];
  const members = ids.length ? await supabaseAdmin.from('gym_users').select('id,managed_full_name,profiles(full_name)').eq('gym_id', request.tenant!.gymId).in('id', ids) : { data: [], error: null };
  check(members.error);
  const names = new Map((members.data ?? []).map((m) => [m.id, (Array.isArray(m.profiles) ? m.profiles[0] : m.profiles)?.full_name ?? m.managed_full_name ?? 'Miembro']));
  const locations = await supabaseAdmin.from('gym_locations').select('id,name').eq('gym_id', request.tenant!.gymId);
  check(locations.error);
  const locationNames = new Map((locations.data ?? []).map((l) => [l.id, l.name]));
  noStore(response); response.json({ requests: (result.data ?? []).map((r) => ({ ...r, member_name: names.get(r.member_user_id), location_name: locationNames.get(r.location_id) })), total: result.count });
}
export async function getMembershipPaymentProof(request: Request, response: Response) {
  const id = parse(z.string().uuid(), request.params.id);
  let query = supabaseAdmin.from('membership_payment_requests').select('id,member_user_id,proof_path,channel,status').eq('gym_id', request.tenant!.gymId).eq('id', id);
  if (request.tenant!.role === 'member') query = query.eq('member_user_id', request.tenant!.gymUserId);
  const { data, error } = await query.maybeSingle(); check(error);
  if (!data || data.status === 'draft' || !data.proof_path || data.channel !== 'fitlab') throw new AppError(404, 'PROOF_NOT_FOUND', 'El comprobante no está disponible.');
  const signed = await supabaseAdmin.storage.from(bucket).createSignedUrl(data.proof_path, 60);
  check(signed.error);
  if (request.tenant!.role !== 'member') {
    const audit = await supabaseAdmin.from('audit_logs').insert({ gym_id: request.tenant!.gymId, actor_gym_user_id: request.tenant!.gymUserId, action: 'membership_payment.proof_viewed', entity_type: 'membership_payment_request', entity_id: id });
    check(audit.error);
  }
  noStore(response); response.json({ url: signed.data!.signedUrl });
}
export async function reviewMembershipPayment(request: Request, response: Response) {
  const input = parse(reviewMembershipPaymentSchema, request.body);
  const { data, error } = await supabaseAdmin.rpc('review_membership_payment_request_backend', { ...context(request), r: parse(z.string().uuid(), request.params.id), decision: input.decision, reason: input.reason, elevated: request.permissionContext?.usedPinElevation ?? false });
  check(error); response.json({ request: data });
}
export async function cancelMembershipPayment(request: Request, response: Response) {
  member(request);
  const { error } = await supabaseAdmin.rpc('cancel_membership_payment_request_backend', { ...context(request), r: parse(z.string().uuid(), request.params.id) });
  check(error); response.json({ cancelled: true });
}
