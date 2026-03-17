import { chromium as stealthChromium } from 'playwright-extra';
import { Browser, BrowserContext, Page } from 'playwright';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';
import { handleCaptchaIfPresent, hasCaptchaSolverKey } from './captcha-solver';

stealthChromium.use(StealthPlugin());

const LINKEDIN_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const LINKEDIN_JOBS_SEARCH_URL = 'https://www.linkedin.com/jobs/search/';
const LINKEDIN_JOBS_API_URL =
  'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const LINKEDIN_LOGIN_URL = 'https://www.linkedin.com/login';

const COOKIES_PATH = path.join(__dirname, '..', 'data', 'linkedin-cookies.json');

const API_PAGE_SIZE = 10;
const AUTH_PAGE_SIZE = 25;
const API_REQUEST_DELAY_MS = 800;
const AUTH_REQUEST_DELAY_MS = 1500;

export const SEARCH_KEYWORDS = {
  gtm: 'Google Tag Manager',
  digitalAnalytics: 'Digital Analytics',
  webAnalytics: 'Web Analytics',
  ga4Gtm: 'GA4 GTM',
  analyticsEngineer: 'Analytics Engineer',
  reactDeveloper: 'React Developer',
  frontendReactTs: 'Frontend React TypeScript',
  nextJsDeveloper: 'Next.js Developer',
  frontendEngineer: 'Frontend Engineer',
  reactTs: 'React TypeScript',
} as const;

type SearchKeywordKey = keyof typeof SEARCH_KEYWORDS;

function resolveQuery(query: string): string {
  const key = query as SearchKeywordKey;
  return SEARCH_KEYWORDS[key] ?? query;
}

function buildSearchParams(rawQuery: string): URLSearchParams {
  const query = resolveQuery(rawQuery);
  return new URLSearchParams({
    keywords: query,
    location: 'Brazil',
    f_WT: '2',
    f_E: '2,3',
  });
}

function buildSearchUrl(rawQuery: string, start = 0): string {
  const params = buildSearchParams(rawQuery);
  params.set('start', String(start));
  return `${LINKEDIN_JOBS_SEARCH_URL}?${params.toString()}`;
}

function buildApiUrl(rawQuery: string, start: number): string {
  const params = buildSearchParams(rawQuery);
  params.set('start', String(start));
  return `${LINKEDIN_JOBS_API_URL}?${params.toString()}`;
}

function getMaxSearchResults(): number {
  const envVal = process.env.MAX_SEARCH_RESULTS;
  if (envVal && !Number.isNaN(Number(envVal)) && Number(envVal) > 0) {
    return Math.floor(Number(envVal));
  }
  return 1000;
}

function randomDelay(baseMs: number): number {
  return baseMs + Math.floor(Math.random() * 600);
}

function hasLinkedInCredentials(): boolean {
  return !!(process.env.LINKEDIN_EMAIL && process.env.LINKEDIN_PASSWORD);
}

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
// Stealth browser setup
// ---------------------------------------------------------------------------

const STEALTH_INIT_SCRIPT = `
  // Remove webdriver property
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  
  // Chrome runtime mock
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = { connect: () => {}, sendMessage: () => {} };
  
  // Permissions mock
  const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
  if (originalQuery) {
    window.navigator.permissions.query = (params) => {
      if (params.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission });
      }
      return originalQuery(params);
    };
  }
  
  // Plugin array mock
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      { name: 'Chrome PDF Plugin', description: 'Portable Document Format', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer', description: '', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
      { name: 'Native Client', description: '', filename: 'internal-nacl-plugin' },
    ],
  });
  
  // Languages
  Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
`;

async function launchBrowser(): Promise<Browser> {
  return stealthChromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-infobars',
      '--window-size=1920,1080',
      '--start-maximized',
    ],
  });
}

async function createContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext({
    userAgent: LINKEDIN_USER_AGENT,
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
// Login with CAPTCHA bypass
// ---------------------------------------------------------------------------

async function loginToLinkedIn(context: BrowserContext): Promise<boolean> {
  const email = process.env.LINKEDIN_EMAIL!;
  const password = process.env.LINKEDIN_PASSWORD!;
  const page = await context.newPage();

  try {
    await page.goto(LINKEDIN_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#username', { timeout: 10000 });

    // Simula digitação humana
    await page.click('#username');
    await page.keyboard.type(email, { delay: 50 + Math.random() * 80 });
    await page.waitForTimeout(400 + Math.random() * 300);

    await page.click('#password');
    await page.keyboard.type(password, { delay: 50 + Math.random() * 80 });
    await page.waitForTimeout(300 + Math.random() * 400);

    await page.click('button[type="submit"]');
    console.log('  🔐 Credenciais enviadas...');

    await page.waitForTimeout(4000);
    let currentUrl = page.url();

    // Verifica se login direto funcionou
    if (/\/(feed|jobs|mynetwork|in\/)/.test(currentUrl)) {
      console.log('  ✅ Login bem-sucedido (sem CAPTCHA)!');
      saveCookies(await context.cookies());
      return true;
    }

    // CAPTCHA/checkpoint detectado → tenta bypass via CapSolver
    if (currentUrl.includes('checkpoint') || currentUrl.includes('challenge')) {
      console.log('  🛡️  Checkpoint de segurança detectado...');

      if (hasCaptchaSolverKey()) {
        const solved = await handleCaptchaIfPresent(page);
        if (solved) {
          console.log('  ✅ Login bem-sucedido após bypass do CAPTCHA!');
          saveCookies(await context.cookies());
          return true;
        }
      } else {
        console.log('  ⚠️  CAPSOLVER_API_KEY não configurada — não é possível fazer bypass do CAPTCHA.');
        console.log('       Configure CAPSOLVER_API_KEY no .env para bypass automático.');
      }

      return false;
    }

    console.log(`  ⚠️  Estado pós-login desconhecido: ${currentUrl}`);
    return false;
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function ensureAuthenticated(context: BrowserContext): Promise<boolean> {
  // Tenta restaurar sessão via cookies salvos
  const cookies = loadCookies();
  if (cookies) {
    await context.addCookies(cookies);
    const page = await context.newPage();
    try {
      await page.goto('https://www.linkedin.com/feed/', {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await page.waitForTimeout(3000);
      const url = page.url();
      if (/\/(feed|jobs|mynetwork|in\/)/.test(url) && !url.includes('login')) {
        console.log('  🍪 Sessão restaurada via cookies.');
        return true;
      }
      console.log('  🍪 Cookies expirados, tentando login...');
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  if (!hasLinkedInCredentials()) return false;
  return loginToLinkedIn(context);
}

// ---------------------------------------------------------------------------
// Job ID extraction
// ---------------------------------------------------------------------------

async function extractGuestJobIds(page: Page): Promise<string[]> {
  return page.$$eval('a.base-card__full-link', (links) => {
    const ids: string[] = [];
    for (const link of links) {
      if (!(link instanceof HTMLAnchorElement)) continue;
      const href = link.href;
      if (!href || !href.includes('/jobs/view/')) continue;
      try {
        const url = new URL(href);
        const seg = url.pathname.split('/').filter(Boolean).pop();
        if (!seg) continue;
        const id = seg.split('-').pop();
        if (id && /^\d+$/.test(id) && !ids.includes(id)) ids.push(id);
      } catch { continue; }
    }
    return ids;
  });
}

async function extractAuthJobIds(page: Page): Promise<string[]> {
  return page.$$eval('a[href*="/jobs/view/"]', (links) => {
    const ids: string[] = [];
    for (const link of links) {
      if (!(link instanceof HTMLAnchorElement)) continue;
      const href = link.href;
      try {
        const url = new URL(href);
        const seg = url.pathname.split('/').filter(Boolean).pop();
        if (!seg) continue;
        const id = seg.split('-').pop();
        if (id && /^\d+$/.test(id) && !ids.includes(id)) ids.push(id);
      } catch { continue; }
    }
    return ids;
  });
}

// ---------------------------------------------------------------------------
// Authenticated search (com login)
// ---------------------------------------------------------------------------

async function searchJobsAuthenticated(
  query: string,
  context: BrowserContext,
  maxResults: number,
): Promise<string[]> {
  const page = await context.newPage();
  const allIds = new Set<string>();
  let consecutiveEmpty = 0;

  try {
    for (let start = 0; start < maxResults; start += AUTH_PAGE_SIZE) {
      const url = buildSearchUrl(query, start);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
      } catch {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) break;
        await page.waitForTimeout(randomDelay(3000));
        continue;
      }

      // Scroll para carregar cards lazy-loaded
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(randomDelay(1500));

      const pageIds = await extractAuthJobIds(page);
      const sizeBefore = allIds.size;
      for (const id of pageIds) allIds.add(id);
      const newCount = allIds.size - sizeBefore;

      if (pageIds.length === 0 || newCount === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 2) break;
      } else {
        consecutiveEmpty = 0;
      }

      if (start > 0 && start % 100 === 0) {
        console.log(`  📄 ... ${allIds.size} vagas coletadas (start=${start})`);
      }

      await page.waitForTimeout(randomDelay(AUTH_REQUEST_DELAY_MS));
    }
  } finally {
    await page.close().catch(() => undefined);
  }

  return Array.from(allIds);
}

// ---------------------------------------------------------------------------
// Guest API search (fallback sem login)
// ---------------------------------------------------------------------------

async function searchJobsGuest(
  query: string,
  context: BrowserContext,
  maxResults: number,
): Promise<string[]> {
  const page = await context.newPage();
  const allIds = new Set<string>();
  let consecutiveEmpty = 0;

  try {
    for (let start = 0; start < maxResults; start += API_PAGE_SIZE) {
      const url = buildApiUrl(query, start);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) break;
        await page.waitForTimeout(randomDelay(2000));
        continue;
      }

      const pageIds = await extractGuestJobIds(page);
      for (const id of pageIds) allIds.add(id);

      if (pageIds.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 2) break;
      } else {
        consecutiveEmpty = 0;
      }

      if (start > 0 && start % 50 === 0) {
        console.log(`  📄 ... ${allIds.size} vagas coletadas (start=${start})`);
      }

      await page.waitForTimeout(randomDelay(API_REQUEST_DELAY_MS));
    }
  } finally {
    await page.close().catch(() => undefined);
  }

  return Array.from(allIds);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Busca vagas no LinkedIn.
 *
 * Com credenciais (LINKEDIN_EMAIL/LINKEDIN_PASSWORD):
 *   1. Restaura sessão via cookies ou faz login com stealth
 *   2. Se CAPTCHA aparecer, faz bypass via CapSolver (CAPSOLVER_API_KEY)
 *   3. Busca autenticada com paginação real (25 vagas/página)
 *
 * Sem credenciais ou se login falhar:
 *   API guest com paginação (10 vagas/página, ~200 vagas max)
 */
export async function searchJobs(query: string): Promise<string[]> {
  const maxResults = getMaxSearchResults();
  const useAuth = hasLinkedInCredentials();
  let browser: Browser | undefined;

  try {
    browser = await launchBrowser();
    const context = await createContext(browser);

    let jobIds: string[];

    if (useAuth) {
      const loggedIn = await ensureAuthenticated(context);
      if (loggedIn) {
        console.log('  🔍 Usando busca autenticada...');
        jobIds = await searchJobsAuthenticated(query, context, maxResults);
      } else {
        console.log('  ⚠️  Login falhou, usando busca guest...');
        jobIds = await searchJobsGuest(query, context, maxResults);
      }
    } else {
      jobIds = await searchJobsGuest(query, context, maxResults);
    }

    console.log(`  📄 Total: ${jobIds.length} vagas únicas encontradas.`);
    return jobIds.map((id) => `https://www.linkedin.com/jobs/view/${id}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

// CLI opcional
if (require.main === module) {
  require('dotenv/config');
  const queryFromArgs = process.argv.slice(2).join(' ').trim();

  if (!queryFromArgs) {
    console.error('Uso: ts-node src/search.ts "<QUERY_DE_BUSCA>"');
    process.exit(1);
  }

  searchJobs(queryFromArgs)
    .then((urls) => {
      const searchUrl = buildSearchUrl(queryFromArgs);
      console.log(JSON.stringify(urls, null, 2));
      console.log(`Encontradas ${urls.length} vagas.`);
      console.log(`🔗 URL de busca do LinkedIn: ${searchUrl}`);
    })
    .catch((err) => {
      console.error('Erro ao buscar vagas:', err);
      process.exit(1);
    });
}
