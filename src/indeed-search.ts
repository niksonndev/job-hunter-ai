import { chromium as stealthChromium } from 'playwright-extra';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';
import { resolveQuery } from './search';

try { stealthChromium.use(StealthPlugin()); } catch { /* already registered */ }

const INDEED_BASE_URL = 'https://br.indeed.com';
const INDEED_SEARCH_PATH = '/jobs';
const INDEED_LOGIN_URL = 'https://secure.indeed.com/auth';

const PAGE_SIZE = 10;
const REQUEST_DELAY_MS = 1500;
const MAX_CONSECUTIVE_EMPTY = 3;
const MANUAL_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

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
// Login manual via headed browser
// ---------------------------------------------------------------------------

const CHROME_PROFILE_PATH = path.join(__dirname, '..', 'data', 'indeed-chrome-profile');

/**
 * Abre o Chrome real com perfil persistente para login manual no Indeed.
 *
 * Usa launchPersistentContext com channel:'chrome' para:
 * - Lançar o Chrome real do sistema (fingerprint TLS correta)
 * - Usar um perfil persistente (parece um browser real de usuário)
 * - Não injetar user-agent/viewport artificiais (menos detecção)
 * - --disable-blink-features=AutomationControlled remove flag de automação
 *
 * Isso contorna o Cloudflare Turnstile que detecta Playwright pelo CDP,
 * navigator.webdriver e fingerprint do Chromium empacotado.
 *
 * Indeed Brasil não tem login com senha — usa Google, Apple ou código por email.
 * Após autenticação, salva cookies em data/indeed-cookies.json.
 */
async function loginIndeedManual(): Promise<boolean> {
  console.log('');
  console.log('  🖥️  Abrindo Chrome para login manual no Indeed...');
  console.log('  ℹ️  Faça login na janela que será aberta (Google, Apple ou código por email).');
  console.log(`  ⏳ Timeout: ${MANUAL_LOGIN_TIMEOUT_MS / 60000} min`);

  let context: BrowserContext | undefined;

  try {
    fs.mkdirSync(CHROME_PROFILE_PATH, { recursive: true });

    context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
      headless: false,
      channel: 'chrome',
      args: [],
      viewport: null,
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      ignoreDefaultArgs: ['--enable-automation'],
    });

    const page = context.pages()[0] || await context.newPage();
    await page.goto(INDEED_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    try {
      await page.waitForURL(
        (url) => {
          const href = url.toString();
          return href.includes('indeed.com') &&
                 !href.includes('/auth') &&
                 !href.includes('login') &&
                 !href.includes('challenge') &&
                 !href.includes('verify') &&
                 !href.includes('secure.indeed');
        },
        { timeout: MANUAL_LOGIN_TIMEOUT_MS },
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
      console.log(`  ❌ Erro ao abrir navegador para login: ${msg}`);
    }
    return false;
  } finally {
    if (context) {
      await context.close().catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

/**
 * Tenta restaurar sessão via cookies.
 * Se os cookies forem válidos, retorna true.
 * Se expirados ou inexistentes, abre headed browser para login manual.
 */
async function ensureIndeedSession(context: BrowserContext): Promise<boolean> {
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

      if (!(await isCloudflareBlocked(page))) {
        const url = page.url();
        if (url.includes('indeed.com') && !url.includes('/auth') && !url.includes('login')) {
          console.log('  🍪 Sessão do Indeed restaurada via cookies.');
          return true;
        }
      }
      console.log('  🍪 Cookies do Indeed expirados ou inválidos.');
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  return false;
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
 * Fluxo:
 *   1. Tenta restaurar sessão via cookies (data/indeed-cookies.json)
 *   2. Se cookies válidos → busca diretamente
 *   3. Se cookies expirados/inexistentes ou Cloudflare bloquear:
 *      → Abre navegador visível para login manual (Google, Apple, código por email)
 *      → Salva cookies após login
 *      → Continua com busca autenticada
 */
export async function searchIndeedJobs(query: string): Promise<string[]> {
  const maxResults = getMaxIndeedResults();
  let browser: Browser | undefined;

  try {
    browser = await launchBrowser();
    let context = await createContext(browser);

    let sessionValid = await ensureIndeedSession(context);

    if (!sessionValid) {
      // Fechar browser headless e abrir headed para login manual
      await browser.close().catch(() => undefined);
      browser = undefined;

      const loginSuccess = await loginIndeedManual();

      browser = await launchBrowser();
      context = await createContext(browser);

      if (loginSuccess) {
        const cookies = loadCookies();
        if (cookies) {
          await context.addCookies(cookies);
          sessionValid = true;
        }
      }
    }

    if (!sessionValid) {
      console.log('  ⚠️  Sem sessão do Indeed. Busca Indeed ignorada nesta execução.');
      return [];
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
