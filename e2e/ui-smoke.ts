/**
 * Clicks through every button and link of the tower, the floors and the control room in a real
 * browser, and fails on anything that does not respond or throws. Run it before a demo:
 *
 *   SMOKE_URL=https://r2-d2.xyz/sentinel/ npm run smoke
 *
 * As a visitor it never starts a run. Against a local server started with DEV_LOGIN=1 it also signs in
 * and goes through the signed-in sheets (tickets, tokens, Jira, People). Links to GitHub are caught
 * and stopped before they leave, so nothing changes there.
 */
import { chromium, type Page } from 'playwright';

const BASE = (process.env.SMOKE_URL ?? 'http://localhost:4200/').replace(/\/?$/, '/');
const results: { name: string; ok: boolean; detail?: string }[] = [];
const errors: string[] = [];
/** Requests a check makes on purpose to see them refused. */
const expectedFailures: RegExp[] = [];

async function check(name: string, fn: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([fn(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('took longer than 45s')), 45_000)))]);
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, detail: (err as Error).message.split('\n')[0] });
  } finally {
    clearTimeout(timer);
  }
  const r = results.at(-1)!;
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
}

function expect(cond: unknown, what: string) {
  if (!cond) throw new Error(what);
}

/** Collects page errors; a reconnecting WebSocket during navigation is not one. */
function watch(page: Page) {
  page.on('pageerror', (e) => errors.push(`${page.url()}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/WebSocket|ERR_ABORTED|ERR_FAILED|favicon|blockedbyclient|Failed to load resource/i.test(m.text())) errors.push(`${page.url()}: ${m.text()}`);
  });
  // Failed requests of our own, with the URL that failed.
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().startsWith(BASE) && !expectedFailures.some((re) => re.test(r.url()))) errors.push(`${r.status()} ${r.request().method()} ${r.url()} (on ${page.url()})`);
  });
}

/**
 * Stops navigation to GitHub and records where the page tried to go. Requests reached through a
 * server redirect are not routed, so every request to GitHub is recorded as well.
 */
async function catchGithub(page: Page): Promise<string[]> {
  const seen: string[] = [];
  page.on('request', (r) => r.url().startsWith('https://github.com/') && seen.push(r.url()));
  await page.route(/https:\/\/github\.com\/.*/, (route) => route.abort());
  return seen;
}

/** The sheet's content once it has loaded. */
async function sheetLoaded(page: Page) {
  await waitFor(async () => !/^Loading/.test(((await page.locator('.sheet-body').textContent()) ?? 'Loading').trim()), 8000);
}

async function waitFor<T>(fn: () => T | Promise<T>, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

const sheetTitle = (page: Page) => page.locator('.sheet header b').textContent({ timeout: 4000 });

async function closeSheet(page: Page) {
  await page.locator('.sheet [data-close]').click();
  await page.locator('.sheet-wrap').waitFor({ state: 'detached', timeout: 3000 });
}

async function lobbyAsVisitor(page: Page) {
  const github = await catchGithub(page);
  await check('lobby loads with its directory', async () => {
    await page.goto(BASE);
    await page.locator('.dir-row').first().waitFor({ timeout: 10000 });
    expect((await page.title()).includes('SentinelQA'), 'title');
  });
  for (const [act, title] of [
    ['reception', 'Ticket desk'],
    ['github', 'GitHub'],
    ['jira', 'Jira'],
    ['agents', 'Agent access'],
  ] as const) {
    await check(`lobby button "${title}" opens its sheet and closes`, async () => {
      await page.locator(`.views [data-act="${act}"]`).click();
      expect((await sheetTitle(page)) === title, `sheet "${title}" did not open`);
      await closeSheet(page);
    });
  }
  await check('Escape closes a sheet', async () => {
    await page.locator('.views [data-act="agents"]').click();
    await page.locator('.sheet').waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.sheet-wrap').waitFor({ state: 'detached', timeout: 3000 });
  });
  await check('Agent access: copy buttons respond', async () => {
    await page.locator('.views [data-act="agents"]').click();
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    const copy = page.locator('.sheet [data-copy]').first();
    await copy.click();
    await waitFor(async () => /Copied|Select/.test((await copy.textContent()) ?? ''));
    await closeSheet(page);
  });
  await check('Connect GitHub link goes to GitHub', async () => {
    await page.locator('.views [data-act="github"]').click();
    await sheetLoaded(page);
    const link = page.locator('.sheet a.btn.go');
    if (!(await link.count())) {
      // Not set up yet on this server: the sheet must say so.
      expect(/setup|public address/i.test((await page.locator('.sheet-body').textContent()) ?? ''), 'no Connect button and no setup note');
      await closeSheet(page);
      return;
    }
    await link.click();
    await waitFor(() => github.some((u) => u.includes('/installations/new')));
    await page.goto(BASE);
  });
  await check('"Continue with GitHub" opens the GitHub sheet', async () => {
    await page.goto(BASE);
    const btn = page.locator('.acct #signin');
    if (!(await btn.count())) return;
    await btn.click();
    expect((await sheetTitle(page)) === 'GitHub', 'GitHub sheet did not open');
    await closeSheet(page);
  });
  await check('lift: panel opens and lists floors', async () => {
    await page.locator('.views [data-act="elevator"]').click();
    await page.locator('.lift-btn').first().waitFor({ timeout: 6000 });
    expect((await page.locator('.lift-btn').count()) >= 2, 'expected the demo floor and the lobby');
    await page.locator('.lift-x').click();
    await page.locator('.lift-panel-wrap').waitFor({ state: 'detached', timeout: 3000 });
  });
  await check('lift: riding to floor 1 opens its office', async () => {
    await page.locator('.views [data-act="elevator"]').click();
    await page.locator('.lift-btn[data-n="1"]').click();
    await page.waitForURL(/office\/\?floor=demo/, { timeout: 8000 });
  });
  await check('directory row takes the lift to its floor', async () => {
    await page.goto(BASE);
    await page.locator('.dir-row[data-n="1"]').click();
    await page.waitForURL(/office\/\?floor=demo/, { timeout: 8000 });
  });
  await check('Control room link opens the console', async () => {
    await page.goto(BASE);
    await page.locator('.views a', { hasText: 'Control room' }).click();
    await page.waitForURL(/console\//, { timeout: 8000 });
  });
}

async function officeAsVisitor(page: Page) {
  const github = await catchGithub(page);
  await check('floor 1 loads with its name', async () => {
    await page.goto(`${BASE}office/?floor=demo`);
    await waitFor(async () => /Floor 1/.test((await page.locator('.floor-name').textContent()) ?? ''), 8000);
  });
  for (const view of ['rival', 'sentinel', 'boards', 'overview']) {
    await check(`floor camera button "${view}"`, async () => {
      await page.locator(`.views [data-view="${view}"]`).click();
      await waitFor(async () => (await page.locator(`.views [data-view="${view}"]`).getAttribute('class'))?.includes('on'));
    });
  }
  await check('agent card opens the full-size screen; Escape closes it', async () => {
    await page.locator('.status .agent').first().click();
    await page.locator('.overlay .panel').waitFor({ timeout: 3000 });
    await page.keyboard.press('Escape');
    await page.locator('.overlay').waitFor({ state: 'detached', timeout: 3000 });
  });
  await check('start button asks a visitor to sign in', async () => {
    const start = page.locator('#start');
    const text = (await start.textContent()) ?? '';
    if (/not open yet/.test(text)) return expect(await start.isDisabled(), 'disabled when sign-in is off');
    expect(/Sign in/.test(text), `start says "${text}"`);
    try {
      await start.click();
      await waitFor(() => github.some((u) => u.includes('/login/oauth/authorize')) || /auth\/(github|dev)/.test(page.url()), 6000).catch(() => {
        throw new Error('clicking did not go to sign-in');
      });
    } finally {
      await page.goto(`${BASE}office/?floor=demo`);
    }
  });
  await check('floor lift goes back to the lobby', async () => {
    await page.locator('.views [data-act="elevator"]').click();
    await page.locator('.lift-btn[data-n="0"]').click();
    await page.waitForURL((u) => u.pathname.endsWith('/') && !u.pathname.includes('office'), { timeout: 8000 });
  });
  await check('a stranger’s floor shows as private', async () => {
    await page.goto(`${BASE}office/?floor=${encodeURIComponent('someone/else')}`);
    await waitFor(async () => /Private floor/.test((await page.locator('.floor-name').textContent()) ?? ''), 8000);
  });
}

async function consolePages(page: Page) {
  await check('console: every page in the menu opens', async () => {
    await page.goto(`${BASE}console/`);
    await page.locator('nav.nav a').first().waitFor({ timeout: 8000 });
    const labels = await page.locator('aside.side nav.nav').first().locator('a').allTextContents();
    for (const label of labels) {
      await page.locator('aside.side nav.nav').first().locator('a', { hasText: label.replace(/\d+$/, '') }).first().click();
      await page.locator('main h1').first().waitFor({ timeout: 6000 });
    }
  });
  await check('console: Lobby link goes back to the tower', async () => {
    await page.locator('a', { hasText: '← Lobby' }).click();
    await page.waitForURL((u) => !u.pathname.includes('console'), { timeout: 8000 });
  });
}

async function signedIn(page: Page) {
  const login = `smoke${Date.now().toString(36)}`;
  await check('dev sign-in', async () => {
    await page.goto(`${BASE}auth/dev?login=${login}`);
    await waitFor(async () => (await page.locator('.acct').textContent())?.includes(`@${login}`), 8000);
  });
  await check('ticket desk: write a ticket, then delete it', async () => {
    await page.locator('.views [data-act="reception"]').click();
    await page.locator('.sheet #key').fill('SMOKE-1');
    await page.locator('.sheet #title').fill('Badge');
    await page.locator('.sheet #criteria').fill('AC-1: Given the shopper is on "/product/clay-mug", when they click "Add to cart", then the "cart badge" shows "1".');
    await page.locator('.sheet #save').click();
    await page.locator('.sheet .fresh').waitFor({ timeout: 60000 });
    await page.locator('.sheet [data-del="SMOKE-1"]').click();
    await waitFor(async () => !(await page.locator('.sheet [data-del="SMOKE-1"]').count()), 8000);
    await closeSheet(page);
  });
  await check('agent access: make a token, then revoke it', async () => {
    await page.locator('.views [data-act="agents"]').click();
    await page.locator('.sheet #name').fill('smoke test');
    await page.locator('.sheet #mint').click();
    await page.locator('.sheet .fresh').waitFor({ timeout: 6000 });
    expect(/sqa_/.test((await page.locator('.sheet .fresh').textContent()) ?? ''), 'token shown');
    await page.locator('.sheet [data-revoke]').first().waitFor({ timeout: 6000 });
    await page.locator('.sheet [data-revoke]').first().click();
    await waitFor(async () => /No tokens yet/.test((await page.locator('.sheet #tokens').textContent()) ?? ''), 6000);
    await closeSheet(page);
  });
  await check('jira: a wrong site is refused with a message', async () => {
    expectedFailures.push(/\/api\/jira\/connect$/);
    await page.locator('.views [data-act="jira"]').click();
    await page.locator('.sheet #site').fill('not a url');
    await page.locator('.sheet #connect').click();
    await waitFor(async () => ((await page.locator('.sheet #e').textContent()) ?? '').length > 0, 6000);
    await closeSheet(page);
  });
  await check('sign out', async () => {
    await page.locator('.acct button', { hasText: 'Sign out' }).click();
    await waitFor(async () => !(await page.locator('.acct').textContent())?.includes(`@${login}`), 8000);
  });
}

console.log(`smoke test against ${BASE}`);
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined, timeout: 30000 });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 800 } });
ctx.setDefaultTimeout(8000);
ctx.setDefaultNavigationTimeout(15000);
const page = await ctx.newPage();
watch(page);
await lobbyAsVisitor(page);
await officeAsVisitor(page);
await consolePages(page);
const dev = await fetch(`${BASE}auth/dev`, { redirect: 'manual' }).then((r) => r.status !== 404).catch(() => false);
if (dev) await signedIn(page);
await browser.close();

for (const e of errors) console.log(`page error  ${e}`);
const failed = results.filter((r) => !r.ok).length + errors.length;
console.log(`\n${results.length - results.filter((r) => !r.ok).length}/${results.length} checks passed${errors.length ? `, ${errors.length} page errors` : ''}${dev ? '' : ' (signed-in checks skipped: DEV_LOGIN is off here)'}`);
process.exit(failed ? 1 : 0);
