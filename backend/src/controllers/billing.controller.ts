import type { Request, Response } from 'express';
import type Stripe from 'stripe';
import { env } from '../config/env.js';
import { stripe } from '../config/stripe.js';
import { supabaseAdmin } from '../config/supabase.js';
import { AppError } from '../errors/AppError.js';

function stripeId(value: string | { id: string } | null) {
  return typeof value === 'string' ? value : value?.id ?? null;
}

function isoFromSeconds(value?: number | null) {
  return value == null ? null : new Date(value * 1000).toISOString();
}

function mapStatus(status: Stripe.Subscription.Status) {
  if (status === 'trialing') return 'trialing';
  if (status === 'active') return 'active';
  if (status === 'past_due' || status === 'unpaid' || status === 'incomplete') return 'past_due';
  if (status === 'canceled') return 'cancelled';
  return 'suspended';
}

export async function getBillingStatus(request: Request, response: Response) {
  if (request.tenant!.role !== 'owner') throw new AppError(403, 'OWNER_REQUIRED', 'Solo el owner puede consultar la suscripción.');
  const { data: gym, error: gymError } = await supabaseAdmin.from('gyms')
    .select('id,name,status').eq('id', request.tenant!.gymId).single();
  const { data: subscription, error: subscriptionError } = await supabaseAdmin.from('gym_subscriptions')
    .select('id,status,trial_ends_at,current_period_starts_at,current_period_ends_at,cancel_at_period_end,provider_customer_id,provider_subscription_id,plan_name_snapshot,price_snapshot,currency_snapshot')
    .eq('gym_id', request.tenant!.gymId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (gymError || subscriptionError || !gym || !subscription) throw new AppError(404, 'BILLING_STATUS_NOT_FOUND', 'No se encontró la suscripción del gimnasio.');
  response.json({ gym, subscription, graceDays: env.SUBSCRIPTION_GRACE_DAYS });
}

export async function createCheckout(request: Request, response: Response) {
  if (request.tenant!.role !== 'owner') throw new AppError(403, 'OWNER_REQUIRED', 'Solo el owner puede activar el plan.');
  const { data: subscription, error } = await supabaseAdmin.from('gym_subscriptions')
    .select('id,status,trial_ends_at,provider_customer_id,provider_subscription_id')
    .eq('gym_id', request.tenant!.gymId).order('created_at', { ascending: false }).limit(1).single();
  if (error || !subscription) throw new AppError(404, 'SUBSCRIPTION_NOT_FOUND', 'No se encontró la suscripción.');
  if (subscription.provider_subscription_id) throw new AppError(409, 'SUBSCRIPTION_ALREADY_LINKED', 'La suscripción ya está vinculada con Stripe.');

  const trialEndSeconds = subscription.trial_ends_at
    ? Math.floor(new Date(subscription.trial_ends_at).getTime() / 1000)
    : 0;
  const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData = {
    metadata: { gym_id: request.tenant!.gymId, local_subscription_id: subscription.id },
  };
  if (trialEndSeconds > Math.floor(Date.now() / 1000) + 48 * 60 * 60) subscriptionData.trial_end = trialEndSeconds;

  const checkout = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
    ...(subscription.provider_customer_id
      ? { customer: String(subscription.provider_customer_id) }
      : request.authUser!.email ? { customer_email: request.authUser!.email } : {}),
    client_reference_id: request.tenant!.gymId,
    metadata: { gym_id: request.tenant!.gymId, local_subscription_id: subscription.id },
    subscription_data: subscriptionData,
    success_url: `${env.STRIPE_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: env.STRIPE_CANCEL_URL,
  });
  if (!checkout.url) throw new AppError(502, 'STRIPE_CHECKOUT_URL_MISSING', 'Stripe no devolvió una página de pago.');
  response.status(201).json({ url: checkout.url });
}

async function applySubscriptionEvent(event: Stripe.Event, subscription: Stripe.Subscription, fallbackGymId?: string | null) {
  const gymId = subscription.metadata.gym_id ?? fallbackGymId;
  if (!gymId) throw new AppError(400, 'STRIPE_GYM_METADATA_MISSING', 'El evento de Stripe no identifica al gimnasio.');
  const period = subscription.items.data[0];
  const { error } = await supabaseAdmin.rpc('apply_stripe_subscription_event', {
    target_event_id: event.id,
    target_event_type: event.type,
    target_payload: event as unknown as Record<string, unknown>,
    target_gym_id: gymId,
    target_customer_id: stripeId(subscription.customer),
    target_subscription_id: subscription.id,
    target_status: mapStatus(subscription.status),
    target_trial_end: isoFromSeconds(subscription.trial_end),
    target_period_start: isoFromSeconds(period?.current_period_start),
    target_period_end: isoFromSeconds(period?.current_period_end),
    target_cancel_at_period_end: subscription.cancel_at_period_end,
  });
  if (error) throw new AppError(500, 'STRIPE_EVENT_PERSISTENCE_FAILED', error.message);
}

export async function stripeWebhook(request: Request, response: Response) {
  const signature = request.headers['stripe-signature'];
  if (!signature || !Buffer.isBuffer(request.body)) throw new AppError(400, 'STRIPE_SIGNATURE_REQUIRED', 'Firma de Stripe ausente.');
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(request.body, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    throw new AppError(400, 'INVALID_STRIPE_SIGNATURE', 'La firma del webhook no es válida.');
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const subscriptionId = stripeId(session.subscription);
    if (subscriptionId) await applySubscriptionEvent(event, await stripe.subscriptions.retrieve(subscriptionId), session.metadata?.gym_id ?? session.client_reference_id);
  } else if (event.type.startsWith('customer.subscription.')) {
    await applySubscriptionEvent(event, event.data.object as Stripe.Subscription);
  } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
    const invoice = event.data.object;
    const related = invoice.parent?.type === 'subscription_details'
      ? invoice.parent.subscription_details?.subscription
      : null;
    const subscriptionId = stripeId(related ?? null);
    if (subscriptionId) await applySubscriptionEvent(event, await stripe.subscriptions.retrieve(subscriptionId));
  }
  response.json({ received: true });
}
