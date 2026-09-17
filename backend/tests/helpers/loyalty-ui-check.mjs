// Built UI + mock API only. Never logs in or sends writes to a real backend.
// node backend/tests/helpers/loyalty-ui-check.mjs <installed-playwright-package> [screenshot-directory]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const { chromium } = await import(pathToFileURL(resolve(process.argv[2], 'index.mjs')).href);
const dist = fileURLToPath(new URL('../../../frontend/dist/', import.meta.url));
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const path = resolve(dist, `.${pathname}`);
    if (!path.startsWith(dist)) { res.writeHead(403).end(); return; }
    const asset = /\.(js|css|png|svg|woff2?)$/.test(path);
    const file = asset ? path : resolve(dist, 'index.html');
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' })[extname(file)] ?? 'text/html');
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  const id = '00000000-0000-4000-8000-000000000001';
  const memberId = '00000000-0000-4000-8000-000000000002';
  let role = 'owner'; let lastWrite; let free = false;
  const p = { id, name: 'Constancia de septiembre', description: 'Reconocemos cada paso de tu entrenamiento.', location_id: id, location_name: 'Principal', status: 'active', starts_on: '2026-09-01', ends_on: '2026-09-30', redeem_until: '2026-10-31', rule_type: 'attendance_count', target: 12, progress: 12, reward_type: 'discount', reward_value: 30, max_rewards: 25, remaining: 20, product_id: null, product_name: null };
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/api/')) {
      const path = url.pathname.split('/api')[1];
      if (route.request().method() !== 'GET') lastWrite = { path, body: route.request().postDataJSON() };
      let data = {};
      if (path === '/auth/me') data = { user: { id, email: 'qa@invalid.test' }, gymUser: { id: role === 'owner' ? id : memberId, gym_id: id, role, status: 'active', default_location_id: id, profiles: { full_name: 'Cuenta de prueba' } } };
      else if (path === '/platform/billing/access') data = { authorized: false };
      else if (path === '/inventory/products') data = { products: [], locations: [{ id, name: 'Principal' }] };
      else if (path === '/members') data = { members: [{ id: memberId, status: 'active', profiles: { full_name: 'Miembro de prueba' } }] };
      else if (path === '/plans') data = { plans: [{ id, name: 'Mensual', price: 100, currency: 'USD' }] };
      else if (path === '/memberships') data = { memberships: [{ id, member_user_id: memberId, plan_id: id, status: 'active', price_at_purchase: 100, currency: 'USD', plans: { name: 'Mensual', price: 100, currency: 'USD' }, membership_periods: [{ starts_on: '2026-09-01', ends_on: '2026-09-30' }] }] };
      else if (path === '/member-payments') data = { payments: [] };
      else if (path === '/loyalty/promotions') data = { promotions: [p] };
      else if (path === '/loyalty/analytics') data = { current: { campaigns: [{ promotion_id: id, name: p.name, currency: 'USD', participants: 8, awarded: 3, redeemed: 2, discount_total: 60, product_cost: 0, unknown_product_costs: 0, free_months: 0, retention_eligible: 0, retention_returned: 0, referrals: 2, qualified_referrals: 1 }] }, snapshot: null, closed_at: null, job: { last_run_at: '2026-09-16T12:00:00Z', pending: false }, pending_rewards: 3, expiring_rewards: 1 };
      else if (path === '/loyalty/me/engagement') data = { referral_code: 'ABCDEF0123456789', unread: 1, preferences: { email: false, whatsapp: false }, notifications: [{ id, title: 'Meta alcanzada', body: 'Tu esfuerzo ya tiene recompensa.', read_at: null }], badges: [{ code: 'first_visit', name: 'Primer paso', description: 'Una asistencia general válida.', earned: true }], mission: { target: 3, progress: 2, week_starts_on: '2026-09-14' }, referrals: { registered: 1, qualified: 1 }, received_referral: null };
      else if (path === '/loyalty/me' || path.startsWith('/loyalty/members/')) data = { today: '2026-09-16', promotions: [p], rewards: role === 'owner' ? [{ id, promotion_id: id, status: 'available', expires_on: '2026-10-31', terms: { ...p, reward_type: free ? 'free_period' : 'discount', reward_value: free ? 1 : 30 } }] : [] };
      else if (path === '/memberships/manual-checkout') data = { checkout: { receipt_number: free ? null : 1, coverage_starts_on: '2026-10-01', coverage_ends_on: '2026-10-31' } };
      await route.fulfill({ json: data, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' } });
    } else if (url.origin === origin) await route.continue();
    else await route.abort();
  });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/loyalty`);
    await page.getByRole('heading', { name: 'Fidelización', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Crear promoción' }).click();
    await page.getByLabel('Regla').selectOption('perfect_attendance');
    assert.equal(await page.getByLabel('Meta de días').count(), 0);
    if (process.argv[3] && width === 390) await page.screenshot({ path: resolve(process.argv[3], 'fitlab-loyalty-owner.png'), fullPage: true });
    const overflow = await page.evaluate(() => [...document.querySelectorAll('.loyalty-page *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).map((el) => ({ tag: el.tagName, class: el.className, text: el.textContent?.slice(0, 35), width: el.getBoundingClientRect().width })).slice(0, 12));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `Owner overflow ${width}: ${JSON.stringify(overflow)}`);
    if (width === 390) {
      await page.getByRole('button', { name: 'Automatización y análisis' }).click();
      await page.getByRole('heading', { name: 'Resultados de tus campañas' }).waitFor();
      await page.getByText('Constancia de septiembre').waitFor();
      if (process.argv[3]) await page.screenshot({ path: resolve(process.argv[3], 'fitlab-loyalty-analytics.png'), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Analytics overflow 390');
    }
  }
  await page.goto(`${origin}/memberships`);
  await page.getByRole('button', { name: 'Renovar', exact: true }).click();
  await page.getByLabel('Recompensa opcional').selectOption(id);
  await Promise.all([page.waitForResponse((response) => response.url().endsWith('/memberships/manual-checkout')), page.getByRole('button', { name: 'Confirmar renovación' }).click()]);
  assert.equal(lastWrite.body.rewardId, id);
  assert.equal(lastWrite.path, '/memberships/manual-checkout');
  free = true;
  await page.reload();
  await page.getByRole('button', { name: 'Renovar', exact: true }).click();
  await page.getByLabel('Recompensa opcional').selectOption(id);
  assert.equal(await page.getByLabel('Método de pago').count(), 0);
  await Promise.all([page.waitForResponse((response) => response.url().endsWith('/memberships/manual-checkout')), page.getByRole('button', { name: 'Confirmar renovación' }).click()]);
  await page.getByText('Recompensa canjeada: cobertura gratuita registrada, sin cobro.').waitFor();
  role = 'member';
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/portal/rewards`);
    await page.getByRole('button', { name: 'Reclamar recompensa', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `Member overflow ${width}`);
    assert.equal(await page.getByRole('button', { name: 'Entregar producto' }).count(), 0);
    if (process.argv[3] && width === 390) await page.screenshot({ path: resolve(process.argv[3], 'fitlab-loyalty-member.png'), fullPage: true });
  }
  await Promise.all([page.waitForResponse((response) => response.url().includes('/claim')), page.getByRole('button', { name: 'Reclamar recompensa', exact: true }).click()]);
  assert.equal(lastWrite.path, `/loyalty/me/promotions/${id}/claim`);
  assert.deepEqual(errors, []);
  console.log('UI OK: owner/member, 320/390/1440px, discount/free checkout and reward claim (mock API).');
} finally { if (browser) await browser.close(); await new Promise((resolve) => server.close(resolve)); }
