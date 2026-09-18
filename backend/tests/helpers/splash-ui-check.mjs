// Built frontend + mocked API only. Verifies responsive media, fallback and real-load exit.
// node backend/tests/helpers/splash-ui-check.mjs <installed-playwright-package> [screenshot-directory]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const { chromium } = await import(pathToFileURL(resolve(process.argv[2], 'index.mjs')).href);
const dist = fileURLToPath(new URL('../../../frontend/dist/', import.meta.url));
const mime = { '.css': 'text/css', '.js': 'text/javascript', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const candidate = resolve(dist, `.${pathname}`);
    if (!candidate.startsWith(dist)) { response.writeHead(403).end(); return; }
    const file = extname(candidate) ? candidate : resolve(dist, 'index.html');
    response.setHeader('Content-Type', mime[extname(file)] ?? 'text/html');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${server.address().port}`;
const id = '00000000-0000-4000-8000-000000000001';
let browser;

async function prepare(page, { failVideo = false, delay = 900 } = {}) {
  const requested = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('.mp4')) {
      requested.push(url.pathname);
      if (failVideo) { await route.abort('failed'); return; }
    }
    if (url.pathname.includes('/api/')) {
      const path = url.pathname.split('/api')[1];
      if (path === '/auth/me') {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
        await route.fulfill({ json: { user: { id, email: 'splash@invalid.test' }, gymUser: { id, gym_id: id, role: 'owner', status: 'active', default_location_id: id, profiles: { full_name: 'Splash test' } } } });
      } else await route.fulfill({ json: {} });
      return;
    }
    if (url.origin !== origin) { await route.abort('blockedbyclient'); return; }
    await route.continue();
  });
  return requested;
}

try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  for (const scenario of [
    { name: 'desktop', width: 1440, height: 900, variant: 'desktop', imageWidth: 1672 },
    { name: 'mobile', width: 390, height: 844, variant: 'mobile', imageWidth: 941 },
  ]) {
    const page = await browser.newPage({ viewport: { width: scenario.width, height: scenario.height } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    const requested = await prepare(page);
    const started = Date.now();
    await page.goto(`${origin}/dashboard`);
    const splash = page.locator('.app-splash');
    await splash.waitFor();
    assert.equal(await splash.getAttribute('data-variant'), scenario.variant);
    assert.equal(await page.locator('.app-splash-fallback').evaluate((image) => image.naturalWidth), scenario.imageWidth);
    assert.equal(await page.locator('.app-splash-media').first().evaluate((element) => getComputedStyle(element).objectFit), 'cover');
    const video = page.locator('.app-splash-video');
    await video.waitFor();
    assert.equal(await video.evaluate((element) => element.muted && element.autoplay && element.playsInline && !element.controls), true);
    assert.equal((await video.getAttribute('src')).endsWith(`fitlab-splash-${scenario.variant}.mp4`), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.argv[3]) await page.screenshot({ path: resolve(process.argv[3], `fitlab-splash-${scenario.name}.png`) });
    await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
    await splash.waitFor({ state: 'detached' });
    assert.ok(Date.now() - started < 4000, 'Splash waited too long instead of following the real session load.');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(248, 250, 252)');
    assert.equal(requested.some((path) => path.includes(`splash-${scenario.variant}.mp4`)), true);
    assert.equal(requested.some((path) => path.includes(`splash-${scenario.variant === 'desktop' ? 'mobile' : 'desktop'}.mp4`)), false);
    assert.deepEqual(errors, []);
    await page.close();
  }

  const fallbackPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await prepare(fallbackPage, { failVideo: true, delay: 1200 });
  await fallbackPage.goto(`${origin}/dashboard`);
  await fallbackPage.locator('.app-splash').waitFor();
  await fallbackPage.locator('.app-splash-video').waitFor({ state: 'detached' });
  assert.equal(await fallbackPage.locator('.app-splash-fallback').evaluate((image) => image.complete && image.naturalWidth > 0), true);
  assert.equal(await fallbackPage.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), 'rgb(3, 4, 5)');
  if (process.argv[3]) await fallbackPage.screenshot({ path: resolve(process.argv[3], 'fitlab-splash-fallback.png') });
  await fallbackPage.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await fallbackPage.close();

  const reducedPage = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const reducedRequests = await prepare(reducedPage, { delay: 700 });
  await reducedPage.goto(`${origin}/dashboard`);
  await reducedPage.locator('.app-splash').waitFor();
  assert.equal(await reducedPage.locator('.app-splash-video').count(), 0);
  assert.equal(reducedRequests.length, 0);
  await reducedPage.getByRole('heading', { name: 'Dashboard' }).waitFor();
  await reducedPage.close();

  console.log('Splash UI OK: desktop/mobile asset selection, proportions, fallback, reduced motion, overflow and real-load exit.');
} finally {
  if (browser) await browser.close();
  await new Promise((resolveClose) => server.close(resolveClose));
}
