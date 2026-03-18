import { chromium as stealthChromium } from 'playwright-extra';
import { Browser, BrowserContext, Page } from 'playwright';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';
import { resolveQuery } from './search';
import { handleCaptchaIfPresent, hasCaptchaSolverKey } from './captcha-solver';

try { stealthChromium.use(StealthPlugin()); } catch { /* already registered */ }

const INDEED_BASE_URL = 'https://br.indeed.com';
const INDEED_SEARCH_PATH = '/jobs';
const INDEED_LOGIN_URL = 'https://secure.indeed.com/auth';

const PAGE_SIZE = 10;
const REQUEST_DELAY_MS = 1500;
const MAX_CONSECUTIVE_EMPTY = 3;
const MANUAL_CAPTCHA_TIMEOUT_MS = 5 * 60 * 1000;

const COOKIES_PATH = path.join(__dirname, '..', 'data', 'indeed-cookies.json');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const STEALTH_INIT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = { connect: () => {}, sendMessage: () => {} };
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', description: '', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      { name: 'Native Client', description: '', filename: 'internal-nacl-plugin' },
    ],
  });
  Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
`;

const BROWSER_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-infobars',
  '--window-size=1920,1080',
  '--start-maximized',
];

type AuthResult = 'authenticated' | 'captcha_required' | 'failed';

// ---------------------------------------------------------------------------
// Cookie persistence
// ---------------------------------------------------------------------------

function loadCookies(): any[] | null {
  try {
    if (fs.existsSync(COOKIES_PATH)) {
      const data = fs.readFileSync(COOKIES_PATH, 'utf-8');
      const cookies = JSON.parse(data);
      if (Array.isArray(cookies) && cookies.length > 0) return cookies;
    }
  } catch { /* ignore */ }
  return null;
}

function saveCookies(cookies: any[]): void {
  fs.mkdirSync(path.dirname(COOKIES_PATH), { recursive: true });
  fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasIndeedCredentials(): boolean {
  return !!(process.env.INDEED_EMAIL && process.env.INDEED_PASSWORD);
}

function buildIndeedSearchUrl(rawQuery: string, start = 0): string {
  const query = resolveQuery(rawQuery);
  const params = new URLSearchParams({
    q: query,
    l: '',
    remotejob: '032b3046-06a3-4876-8dfd-474eb5e7ed11',
    start: String(start),
  });
  return `${INDEED_BASE_URL}${INDEED_SEARCH_PATH}?${params.toString()}`;
}

function getMaxIndeedResults(): number {
  const envVal = process.env.MAX_SEARCH_RESULTS;
  if (envVal && !Number.isNaN(Number(envVal)) && Number(envVal) > 0) {
    return Math.min(Math.floor(Number(envVal)), 200);
  }
  return 200;
}

function randomDelay(baseMs: number): number {
  return baseMs + Math.floor(Math.random() * 600);
}

async function launchBrowser(headless = true): Promise<Browser> {
  return stealthChromium.launch({ headless, args: BROWSER_ARGS });
}

async function createContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1920, height: 1080 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    extraHTTPHeaders: {
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });
  await ctx.addInitScript(STEALTH_INIT_SCRIPT);
  return ctx;
}

// ---------------------------------------------------------------------------
// Cloudflare detection
// ---------------------------------------------------------------------------

async function isCloudflareBlocked(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const title = document.title?.toLowerCase() || '';
    const body = document.body?.innerText?.toLowerCase() || '';
    return title.includes('security check') ||
           title.includes('um momento') ||
           title.includes('just a moment') ||
           body.includes('verificação adicional necessária') ||
           body.includes('additional verification required') ||
           body.includes('não é um robô') ||
           body.includes('not a robot') ||
           body.includes('unusual traffic');
  }).catch(() => false);
}

// ---------------------------------------------------------------------------
// Indeed login
// ---------------------------------------------------------------------------

async function loginToIndeed(context: BrowserContext): Promise<AuthResult> {
  const email = process.env.INDEED_EMAIL!;
  const password = process.env.INDEED_PASSWORD!;
  const page = await context.newPage();

  try {
    console.log('  🔐 Fazendo login no Indeed...');
    await page.goto(INDEED_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    if (await isCloudflareBlocked(page)) {
      console.log('  ⚠️  Cloudflare bloqueou a página de login do Indeed.');
      return 'captcha_required';
    }

    // Indeed login: step 1 — email
    const emailSelector = 'input[type="email"], input[name="__email"], #ifl-InputFormField-3';
    try {
      await page.waitForSelector(emailSelector, { timeout: 10000 });
    } catch {
      console.log('  ⚠️  Campo de email não encontrado na página de login.');
      return 'failed';
    }

    await page.click(emailSelector);
    await page.keyboard.type(email, { delay: 50 + Math.random() * 80 });
    await page.waitForTimeout(400 + Math.random() * 300);

    await page.click('button[type="submit"]');
    console.log('  📧 Email enviado...');
    await page.waitForTimeout(3000 + Math.random() * 1000);

    // Indeed login: step 2 — password
    const passwordSelector = 'input[type="password"], input[name="__password"], #ifl-InputFormField-7';
    try {
      await page.waitForSelector(passwordSelector, { timeout: 10000 });
    } catch {
      // May have gone directly to CAPTCHA or verification
      if (await isCloudflareBlocked(page)) {
        return 'captcha_required';
      }
      console.log('  ⚠️  Campo de senha não encontrado após envio do email.');
      return 'failed';
    }

    await page.click(passwordSelector);
    await page.keyboard.type(password, { delay: 50 + Math.random() * 80 });
    await page.waitForTimeout(300 + Math.random() * 400);

    await page.click('button[type="submit"]');
    console.log('  🔑 Senha enviada...');
    await page.waitForTimeout(5000);

    const currentUrl = page.url();

    // Check if login succeeded — Indeed redirects to homepage or jobs
    if (currentUrl.includes('indeed.com') &&
        !currentUrl.includes('/auth') &&
        !currentUrl.includes('login') &&
        !currentUrl.includes('challenge') &&
        !currentUrl.includes('verify')) {
      console.log('  ✅ Login no Indeed bem-sucedido!');
      saveCookies(await context.cookies());
      return 'authenticated';
    }

    // Check for CAPTCHA / verification
    if (currentUrl.includes('challenge') ||
        currentUrl.includes('verify') ||
        currentUrl.includes('security')) {
      console.log('  🛡️  Verificação de segurança detectada no Indeed...');

      if (hasCaptchaSolverKey()) {
        const solved = await handleCaptchaIfPresent(page);
        if (solved) {
          await page.waitForTimeout(3000);
          const postCaptchaUrl = page.url();
          if (!postCaptchaUrl.includes('/auth') && !postCaptchaUrl.includes('login')) {
            console.log('  ✅ Login no Indeed bem-sucedido após bypass do CAPTCHA!');
            saveCookies(await context.cookies());
            return 'authenticated';
          }
        }
        console.log('  ⚠️  CapSolver não conseguiu resolver o CAPTCHA do Indeed.');
      }

      return 'captcha_required';
    }

    if (await isCloudflareBlocked(page)) {
      return 'captcha_required';
    }

    console.log(`  ⚠️  Estado pós-login desconhecido no Indeed: ${currentUrl}`);
    return 'failed';
  } finally {
    await page.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Login manual com navegador visível (para CAPTCHA/Cloudflare)
// ---------------------------------------------------------------------------

async function loginIndeedWithManualCaptcha(): Promise<boolean> {
  console.log('');
  console.log('  🖥️  Abrindo navegador visível para login manual no Indeed...');
  console.log('  ℹ️  Complete o login e a verificação na janela do navegador.');

  let browser: Browser | undefined;

  try {
    browser = await launchBrowser(false);
    const context = await createContext(browser);
    const page = await context.newPage();

    const email = process.env.INDEED_EMAIL!;
    const password = process.env.INDEED_PASSWORD!;

    await page.goto(INDEED_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Try to fill email if field is available (may be blocked by Cloudflare)
    const emailSelector = 'input[type="email"], input[name="__email"], #ifl-InputFormField-3';
    try {
      await page.waitForSelector(emailSelector, { timeout: 10000 });
      await page.click(emailSelector);
      await page.keyboard.type(email, { delay: 50 + Math.random() * 80 });
      await page.waitForTimeout(400 + Math.random() * 300);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(3000);

      const passwordSelector = 'input[type="password"], input[name="__password"], #ifl-InputFormField-7';
      try {
        await page.waitForSelector(passwordSelector, { timeout: 10000 });
        await page.click(passwordSelector);
        await page.keyboard.type(password, { delay: 50 + Math.random() * 80 });
        await page.waitForTimeout(300 + Math.random() * 400);
        await page.click('button[type="submit"]');
      } catch { /* user will complete manually */ }
    } catch {
      console.log('  ℹ️  Página bloqueada. Complete o processo manualmente.');
    }

    console.log(`  ⏳ Aguardando login manual no Indeed... (timeout: ${MANUAL_CAPTCHA_TIMEOUT_MS / 60000} min)`);

    try {
      // Wait until user lands on an Indeed page (not auth/login)
      await page.waitForURL(
        (url) => {
          const href = url.toString();
          return href.includes('indeed.com') &&
                 !href.includes('/auth') &&
                 !href.includes('login') &&
                 !href.includes('challenge') &&
                 !href.includes('verify');
        },
        { timeout: MANUAL_CAPTCHA_TIMEOUT_MS },
      );
      console.log('  ✅ Login no Indeed bem-sucedido! Salvando sessão...');
      saveCookies(await context.cookies());
      return true;
    } catch {
      console.log('  ❌ Timeout aguardando login manual no Indeed.');
      return false;
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (msg.includes('Target closed') || msg.includes('Browser closed')) {
      console.log('  ❌ Navegador foi fechado antes da conclusão do login.');
    } else {
      console.log(`  ❌ Erro ao abrir navegador para login manual: ${msg}`);
    }
    return false;
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

async function ensureIndeedAuthenticated(context: BrowserContext): Promise<AuthResult> {
  const cookies = loadCookies();
  if (cookies) {
    await context.addCookies(cookies);
    const page = await context.newPage();
    try {
      await page.goto(`${INDEED_BASE_URL}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await page.waitForTimeout(3000);

      if (await isCloudflareBlocked(page)) {
        console.log('  🍪 Cookies do Indeed expirados (Cloudflare challenge). Tentando login...');
      } else {
        const url = page.url();
        if (url.includes('indeed.com') && !url.includes('/auth') && !url.includes('login')) {
          console.log('  🍪 Sessão do Indeed restaurada via cookies.');
          return 'authenticated';
        }
        console.log('  🍪 Cookies do Indeed expirados, tentando login...');
      }
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  if (!hasIndeedCredentials()) return 'failed';
  return loginToIndeed(context);
}

// ---------------------------------------------------------------------------
// Job key extraction
// ---------------------------------------------------------------------------

async function extractIndeedJobKeys(page: Page): Promise<string[]> {
  const fromDataJk = await page.$$eval('[data-jk]', (elements) => {
    const keys: string[] = [];
    for (const el of elements) {
      const jk = el.getAttribute('data-jk');
      if (jk && !keys.includes(jk)) keys.push(jk);
    }
    return keys;
  }).catch(() => [] as string[]);

  if (fromDataJk.length > 0) return fromDataJk;

  return page.$$eval('a[href*="jk="]', (links) => {
    const keys: string[] = [];
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/[?&]jk=([a-f0-9]+)/i);
      if (match && !keys.includes(match[1])) keys.push(match[1]);
    }
    return keys;
  }).catch(() => [] as string[]);
}

// ---------------------------------------------------------------------------
// Search (paginação)
// ---------------------------------------------------------------------------

async function searchIndeedPaginated(
  query: string,
  context: BrowserContext,
  maxResults: number,
): Promise<string[]> {
  const page = await context.newPage();
  const allKeys = new Set<string>();
  let consecutiveEmpty = 0;

  try {
    for (let start = 0; start < maxResults; start += PAGE_SIZE) {
      const url = buildIndeedSearchUrl(query, start);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(randomDelay(1000));
      } catch {
        consecutiveEmpty++;
        if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) break;
        await page.waitForTimeout(randomDelay(2000));
        continue;
      }

      if (await isCloudflareBlocked(page)) {
        console.log('  ⚠️  Indeed protegido por Cloudflare durante paginação.');
        break;
      }

      if (start === 0) {
        saveCookies(await context.cookies());
      }

      const pageKeys = await extractIndeedJobKeys(page);
      const sizeBefore = allKeys.size;
      for (const key of pageKeys) allKeys.add(key);
      const newCount = allKeys.size - sizeBefore;

      console.log(`  📄 Indeed start=${start}: ${pageKeys.length} cards, ${newCount} novos (total: ${allKeys.size})`);

      if (pageKeys.length === 0 || newCount === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY) break;
      } else {
        consecutiveEmpty = 0;
      }

      await page.waitForTimeout(randomDelay(REQUEST_DELAY_MS));
    }
  } finally {
    await page.close().catch(() => undefined);
  }

  return Array.from(allKeys);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Busca vagas no Indeed Brasil com filtro de trabalho remoto.
 *
 * Com credenciais (INDEED_EMAIL/INDEED_PASSWORD):
 *   1. Restaura sessão via cookies ou faz login com stealth (headless)
 *   2. Se CAPTCHA/Cloudflare aparecer:
 *      a. Tenta bypass via CapSolver (se CAPSOLVER_API_KEY estiver configurada)
 *      b. Se falhar, abre navegador visível para o usuário resolver manualmente
 *   3. Executa busca autenticada com paginação
 *
 * Sem credenciais:
 *   Tenta busca guest (pode ser bloqueada por Cloudflare em IPs de datacenter)
 */
export async function searchIndeedJobs(query: string): Promise<string[]> {
  const maxResults = getMaxIndeedResults();
  const useAuth = hasIndeedCredentials();
  let browser: Browser | undefined;

  try {
    browser = await launchBrowser();
    let context = await createContext(browser);
    let authenticated = false;

    if (useAuth) {
      const authResult = await ensureIndeedAuthenticated(context);

      if (authResult === 'captcha_required') {
        await browser.close().catch(() => undefined);
        browser = undefined;

        const manualSuccess = await loginIndeedWithManualCaptcha();

        browser = await launchBrowser();
        context = await createContext(browser);

        if (manualSuccess) {
          const cookies = loadCookies();
          if (cookies) {
            await context.addCookies(cookies);
            authenticated = true;
          }
        }
      } else if (authResult === 'authenticated') {
        authenticated = true;
      }
    }

    if (!authenticated && !useAuth) {
      // Guest mode: just try searching directly
      const page = await context.newPage();
      try {
        await page.goto(`${INDEED_BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
        if (await isCloudflareBlocked(page)) {
          console.log('  ⚠️  Indeed protegido por Cloudflare. Configure INDEED_EMAIL e INDEED_PASSWORD no .env para autenticação.');
          return [];
        }
      } finally {
        await page.close().catch(() => undefined);
      }
    }

    if (!authenticated && useAuth) {
      console.log('  ⚠️  Login no Indeed falhou. Tentando busca sem autenticação...');
    }

    const jobKeys = await searchIndeedPaginated(query, context, maxResults);
    console.log(`  📄 Indeed: ${jobKeys.length} vagas únicas encontradas.`);
    return jobKeys.map((key) => `${INDEED_BASE_URL}/viewjob?jk=${key}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

if (require.main === module) {
  require('dotenv/config');
  const queryFromArgs = process.argv.slice(2).join(' ').trim();

  if (!queryFromArgs) {
    console.error('Uso: ts-node src/indeed-search.ts "<QUERY_DE_BUSCA>"');
    process.exit(1);
  }

  searchIndeedJobs(queryFromArgs)
    .then((urls) => {
      console.log(JSON.stringify(urls, null, 2));
      console.log(`Encontradas ${urls.length} vagas no Indeed.`);
    })
    .catch((err) => {
      console.error('Erro ao buscar vagas no Indeed:', err);
      process.exit(1);
    });
}
