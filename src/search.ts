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
const MANUAL_CAPTCHA_TIMEOUT_MS = 5 * 60 * 1000;

type AuthResult = 'authenticated' | 'captcha_required' | 'failed';

export const SEARCH_KEYWORDS = {
  frontend: {
    reactDeveloper: 'React Developer',
    frontendReactTs: 'Frontend React TypeScript',
    nextJsDeveloper: 'Next.js Developer',
    frontendEngineer: 'Frontend Engineer',
    /* angularDeveloper: 'Angular Developer', */
  },
  backend: {
    nodeJsDeveloper: 'Node.js Developer',
    backendEngineer: 'Backend Engineer',
    /* pythonDeveloper: 'Python Developer',
    javaDeveloper: 'Java Developer',
    golangDeveloper: 'Golang Developer', */
  },
  fullstack: {
    fullstackDeveloper: 'Fullstack Developer',
    fullstackEngineer: 'Fullstack Engineer',
    fullstackReactNode: 'Fullstack React Node',
    fullstackTypeScript: 'Fullstack TypeScript',
    fullstackJavaScript: 'Fullstack JavaScript',
  },
  webAnalytics: {
    gtm: 'Google Tag Manager',
    digitalAnalytics: 'Digital Analytics',
    webAnalyticsKeyword: 'Web Analytics',
    ga4Gtm: 'GA4 GTM',
    analyticsEngineer: 'Analytics Engineer',
  },
} as const;

export type SearchCategory = keyof typeof SEARCH_KEYWORDS;

function buildFlatKeywords(): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const category of Object.values(SEARCH_KEYWORDS)) {
    for (const [key, value] of Object.entries(category)) {
      flat[key] = value;
    }
  }
  return flat;
}

const FLAT_KEYWORDS = buildFlatKeywords();

export function resolveQuery(query: string): string {
  return FLAT_KEYWORDS[query] ?? query;
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

const BROWSER_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-infobars',
  '--window-size=1920,1080',
  '--start-maximized',
];

async function launchBrowser(headless = true): Promise<Browser> {
  return stealthChromium.launch({ headless, args: BROWSER_ARGS });
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

async function loginToLinkedIn(context: BrowserContext): Promise<AuthResult> {
  const email = process.env.LINKEDIN_EMAIL!;
  const password = process.env.LINKEDIN_PASSWORD!;
  const page = await context.newPage();

  try {
    await page.goto(LINKEDIN_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#username', { timeout: 10000 });

    await page.click('#username');
    await page.keyboard.type(email, { delay: 50 + Math.random() * 80 });
    await page.waitForTimeout(400 + Math.random() * 300);

    await page.click('#password');
    await page.keyboard.type(password, { delay: 50 + Math.random() * 80 });
    await page.waitForTimeout(300 + Math.random() * 400);

    await page.click('button[type="submit"]');
    console.log('  🔐 Credenciais enviadas...');

    await page.waitForTimeout(4000);
    const currentUrl = page.url();

    if (/\/(feed|jobs|mynetwork|in\/)/.test(currentUrl)) {
      console.log('  ✅ Login bem-sucedido (sem CAPTCHA)!');
      saveCookies(await context.cookies());
      return 'authenticated';
    }

    if (currentUrl.includes('checkpoint') || currentUrl.includes('challenge')) {
      console.log('  🛡️  Checkpoint de segurança detectado...');

      if (hasCaptchaSolverKey()) {
        const solved = await handleCaptchaIfPresent(page);
        if (solved) {
          console.log('  ✅ Login bem-sucedido após bypass do CAPTCHA!');
          saveCookies(await context.cookies());
          return 'authenticated';
        }
        console.log('  ⚠️  CapSolver não conseguiu resolver o CAPTCHA.');
      }

      return 'captcha_required';
    }

    console.log(`  ⚠️  Estado pós-login desconhecido: ${currentUrl}`);
    return 'failed';
  } finally {
    await page.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Login manual com navegador visível (para CAPTCHA)
// ---------------------------------------------------------------------------

async function loginWithManualCaptcha(): Promise<boolean> {
  console.log('');
  console.log('  🖥️  Abrindo navegador visível para resolver CAPTCHA manualmente...');
  console.log('  ℹ️  Complete a verificação na janela do navegador que será aberta.');

  let browser: Browser | undefined;

  try {
    browser = await launchBrowser(false);
    const context = await createContext(browser);
    const page = await context.newPage();

    const email = process.env.LINKEDIN_EMAIL!;
    const password = process.env.LINKEDIN_PASSWORD!;

    await page.goto(LINKEDIN_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#username', { timeout: 10000 });

    await page.click('#username');
    await page.keyboard.type(email, { delay: 50 + Math.random() * 80 });
    await page.waitForTimeout(400 + Math.random() * 300);

    await page.click('#password');
    await page.keyboard.type(password, { delay: 50 + Math.random() * 80 });
    await page.waitForTimeout(300 + Math.random() * 400);

    await page.click('button[type="submit"]');
    console.log('  🔐 Credenciais enviadas.');
    console.log(`  ⏳ Aguardando resolução manual do CAPTCHA... (timeout: ${MANUAL_CAPTCHA_TIMEOUT_MS / 60000} min)`);

    try {
      await page.waitForURL(/\/(feed|jobs|mynetwork|in\/)/, { timeout: MANUAL_CAPTCHA_TIMEOUT_MS });
      console.log('  ✅ Login bem-sucedido! Salvando sessão...');
      saveCookies(await context.cookies());
      return true;
    } catch {
      console.log('  ❌ Timeout aguardando resolução do CAPTCHA.');
      return false;
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (msg.includes('Target closed') || msg.includes('Browser closed')) {
      console.log('  ❌ Navegador foi fechado antes da resolução do CAPTCHA.');
    } else {
      console.log(`  ❌ Erro ao abrir navegador para CAPTCHA manual: ${msg}`);
    }
    return false;
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

async function ensureAuthenticated(context: BrowserContext): Promise<AuthResult> {
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
        return 'authenticated';
      }
      console.log('  🍪 Cookies expirados, tentando login...');
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  if (!hasLinkedInCredentials()) return 'failed';
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

const JOB_LIST_CONTAINER_SELECTORS = [
  '.jobs-search-results-list',
  '.scaffold-layout__list-container',
  '.scaffold-layout__list',
  '.jobs-search__results-list',
];

async function countJobLinks(page: Page): Promise<number> {
  return page.$$eval('a[href*="/jobs/view/"]', (links) => {
    const seen = new Set<string>();
    for (const link of links) {
      if (!(link instanceof HTMLAnchorElement)) continue;
      const m = link.href.match(/\/jobs\/view\/(\d+)/);
      if (m) seen.add(m[1]);
    }
    return seen.size;
  });
}

async function scrollAndLoadAllCards(page: Page): Promise<void> {
  const MAX_SCROLL_ATTEMPTS = 15;
  let prevCount = await countJobLinks(page);

  for (let i = 0; i < MAX_SCROLL_ATTEMPTS; i++) {
    await page.evaluate((containerSels) => {
      for (const sel of containerSels) {
        const el = document.querySelector(sel);
        if (el) {
          el.scrollBy(0, 600);
          return;
        }
      }
      window.scrollBy(0, 600);
    }, JOB_LIST_CONTAINER_SELECTORS);

    await page.waitForTimeout(randomDelay(700));

    const currentCount = await countJobLinks(page);
    if (currentCount === prevCount && i >= 3) break;
    prevCount = currentCount;
  }
}

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
        try {
          await page.waitForSelector('a[href*="/jobs/view/"]', { timeout: 10000 });
        } catch { /* página pode estar vazia */ }
        await page.waitForTimeout(randomDelay(1500));
      } catch {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) break;
        await page.waitForTimeout(randomDelay(3000));
        continue;
      }

      await scrollAndLoadAllCards(page);

      const pageIds = await extractAuthJobIds(page);
      const sizeBefore = allIds.size;
      for (const id of pageIds) allIds.add(id);
      const newCount = allIds.size - sizeBefore;

      console.log(`  📄 Página start=${start}: ${pageIds.length} cards, ${newCount} novos (total: ${allIds.size})`);

      if (pageIds.length === 0 || newCount === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) break;
      } else {
        consecutiveEmpty = 0;
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
 * Busca vagas no LinkedIn usando estratégia dual (autenticada + guest).
 *
 * Com credenciais (LINKEDIN_EMAIL/LINKEDIN_PASSWORD):
 *   1. Restaura sessão via cookies ou faz login com stealth (headless)
 *   2. Se CAPTCHA aparecer:
 *      a. Tenta bypass via CapSolver (se CAPSOLVER_API_KEY estiver configurada)
 *      b. Se CapSolver falhar ou não estiver configurada, abre navegador visível
 *         para o usuário resolver o CAPTCHA manualmente (timeout: 5 min)
 *   3. Executa busca autenticada (25 vagas/página) + busca guest (10 vagas/página)
 *   4. Combina resultados de ambas as buscas (union de IDs únicos)
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
    let context = await createContext(browser);
    let authenticated = false;

    if (useAuth) {
      const authResult = await ensureAuthenticated(context);

      if (authResult === 'captcha_required') {
        await browser.close().catch(() => undefined);
        browser = undefined;

        const manualSuccess = await loginWithManualCaptcha();

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

    const mergedIds = new Set<string>();

    if (authenticated) {
      console.log('  🔍 Busca autenticada...');
      const authIds = await searchJobsAuthenticated(query, context, maxResults);
      for (const id of authIds) mergedIds.add(id);
      console.log(`  📊 Autenticada: ${authIds.length} vagas`);

      console.log('  🔍 Complementando com busca guest (API pública)...');
      const guestIds = await searchJobsGuest(query, context, maxResults);
      const guestNew = guestIds.filter((id) => !mergedIds.has(id));
      for (const id of guestIds) mergedIds.add(id);
      console.log(`  📊 Guest: ${guestIds.length} vagas (+${guestNew.length} novas)`);
    } else {
      if (useAuth) console.log('  ⚠️  Login falhou, usando busca guest...');
      const guestIds = await searchJobsGuest(query, context, maxResults);
      for (const id of guestIds) mergedIds.add(id);
    }

    const jobIds = Array.from(mergedIds);
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
