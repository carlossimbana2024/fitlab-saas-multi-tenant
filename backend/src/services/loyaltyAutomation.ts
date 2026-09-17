import { env } from '../config/env.js';
import { supabaseAdmin } from '../config/supabase.js';

// The adapter must deduplicate Idempotency-Key and accept both configured channels.
export async function runLoyaltyAutomation() {
  const deadline = Date.now() + 40_000;
  let batches = 0;
  let failed = 0;
  let done = false;
  while (Date.now() < deadline && batches < 50) {
    const { data, error } = await supabaseAdmin.rpc('run_next_loyalty_batch_backend');
    if (error) throw new Error('LOYALTY_EVALUATION_FAILED');
    if (!data) { done = true; break; }
    batches++;
    if (data.failed) failed++;
  }
  let delivered = 0;
  if (env.LOYALTY_DELIVERY_URL && env.LOYALTY_DELIVERY_TOKEN && Date.now() < deadline) {
    const { data, error } = await supabaseAdmin.rpc('claim_loyalty_deliveries_backend');
    if (error) throw new Error('LOYALTY_DELIVERY_CLAIM_FAILED');
    const deliveries = (data ?? []) as { id: string; lease_token: string; channel: string; recipient: string | null; title: string; body: string; gym_id: string }[];
    for (let offset = 0; offset < deliveries.length; offset += 4) {
      await Promise.all(deliveries.slice(offset, offset + 4).map(async (item) => {
        let success = false;
        let failure = 'RECIPIENT_MISSING';
        if (item.recipient) {
          try {
            const result = await fetch(env.LOYALTY_DELIVERY_URL!, {
              method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
              headers: { Authorization: `Bearer ${env.LOYALTY_DELIVERY_TOKEN}`, 'Content-Type': 'application/json', 'Idempotency-Key': item.id },
              body: JSON.stringify({ id: item.id, channel: item.channel, recipient: item.recipient, title: item.title, body: item.body, gymId: item.gym_id }),
            });
            success = result.ok;
            failure = 'PROVIDER_REJECTED';
          } catch { failure = 'PROVIDER_UNAVAILABLE'; }
        }
        const { error: finishError } = await supabaseAdmin.rpc('finish_loyalty_delivery_backend', { delivery: item.id, token: item.lease_token, success, error_code: success ? null : failure });
        if (finishError) throw new Error('LOYALTY_DELIVERY_ACK_FAILED');
        if (success) delivered++;
      }));
    }
  }
  return { batches, failed, done, delivered, externalDeliveryConfigured: Boolean(env.LOYALTY_DELIVERY_URL && env.LOYALTY_DELIVERY_TOKEN) };
}
