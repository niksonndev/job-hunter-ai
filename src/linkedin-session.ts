import { chromium as stealthChromium } from 'playwright-extra';
import { Browser, BrowserContext } from 'playwright';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';
import { handleCaptchaIfPresent, hasCaptchaSolverKey } from './captcha-solver';

stealthChromium.use(StealthPlugin());

export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export interface LinkedInSession {
  cookies: SessionCookie[];
  csrfToken: string;
  userAgent: string;
  voyagerQueryId: string | null;
  createdAt: number;
}

const SESSION_PATH = path.join(__dirname, '..', 'data', 'linkedin-session.json');

const LINKEDIN_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const LINKEDIN_LOGIN_URL = 'https://www.linkedin.com/login';
const MANUAL_CAPTCHA_TIMEOUT_MS = 5 * 60 * 1000;

type AuthResult = 'authenticated' | 'captcha_required' | 'failed';

const STEALTH_INIT_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = { connect: () => {}, sendMessage: () => {} };

  const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
  if (originalQuery) {
    window.navigator.permissions.query = (params) => {
      if (params.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission });
      }
      return originalQuery(params);
    };
  }

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
// Session persistence
// ---------------------------------------------------------------------------

function loadSession(): LinkedInSession | null {
  try {
    if (fs.existsSync(SESSION_PATH)) {
      const data = fs.readFileSync(SESSION_PATH, 'utf-8');
      return JSON.parse(data) as LinkedInSession;
    }
  } catch { /* ignore corrupt file */ }
  return null;
}

function saveSessionToDisk(session: LinkedInSession): void {
  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
  fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
}

function extractCsrfToken(cookies: SessionCookie[]): string {
  const jsessionid = cookies.find((c) => c.name === 'JSESSIONID');
  if (!jsessionid) return '';
  return jsessionid.value.replace(/"/g, '');
}

export function buildCookieHeader(session: LinkedInSession): string {
  return session.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

// ---------------------------------------------------------------------------
// HTTP session validation (no Playwright needed)
// ---------------------------------------------------------------------------

export async function validateSessionHttp(session: LinkedInSession): Promise<boolean> {
  try {
    const res = await fetch('https://www.linkedin.com/feed/', {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Cookie: buildCookieHeader(session),
        'User-Agent': session.userAgent,
      },
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Browser helpers (used only during login)
// ---------------------------------------------------------------------------

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

function hasLinkedInCredentials(): boolean {
  return !!(process.env.LINKEDIN_EMAIL && process.env.LINKEDIN_PASSWORD);
}

function playwrightCookiesToSession(rawCookies: Array<{ name: string; value: string; domain: string; path: string }>): SessionCookie[] {
  return rawCookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
  }));
}

// ---------------------------------------------------------------------------
// Login via Playwright (headless stealth)
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
      console.log('  ✅ Login bem-sucedido!');
      return 'authenticated';
    }

    if (currentUrl.includes('checkpoint') || currentUrl.includes('challenge')) {
      console.log('  🛡️  Checkpoint de segurança detectado...');

      if (hasCaptchaSolverKey()) {
        const solved = await handleCaptchaIfPresent(page);
        if (solved) {
          console.log('  ✅ Login bem-sucedido após bypass do CAPTCHA!');
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
// Manual CAPTCHA login (visible browser)
// ---------------------------------------------------------------------------

async function loginWithManualCaptcha(): Promise<{ success: boolean; cookies?: SessionCookie[] }> {
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
      console.log('  ✅ Login bem-sucedido! Extraindo sessão...');
      const rawCookies = await context.cookies();
      return { success: true, cookies: playwrightCookiesToSession(rawCookies) };
    } catch {
      console.log('  ❌ Timeout aguardando resolução do CAPTCHA.');
      return { success: false };
    }
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    if (msg.includes('Target closed') || msg.includes('Browser closed')) {
      console.log('  ❌ Navegador foi fechado antes da resolução do CAPTCHA.');
    } else {
      console.log(`  ❌ Erro ao abrir navegador para CAPTCHA manual: ${msg}`);
    }
    return { success: false };
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Voyager QueryID / endpoint capture via network intercept
// ---------------------------------------------------------------------------

async function captureVoyagerQueryId(context: BrowserContext): Promise<string | null> {
  const page = await context.newPage();
  let queryId: string | null = null;

  page.on('request', (request) => {
    const url = request.url();
    if (!url.includes('/voyager/api/')) return;
    if (!url.includes('jobSearch') && !url.includes('JobCards')) return;

    const qidMatch = url.match(/queryId=([^&]+)/);
    if (qidMatch) {
      queryId = qidMatch[1];
      return;
    }

    const decMatch = url.match(/decorationId=([^&]+)/);
    if (decMatch) {
      queryId = `decoration:${decMatch[1]}`;
    }
  });

  try {
    await page.goto(
      'https://www.linkedin.com/jobs/search/?keywords=Developer&location=Brazil&f_WT=2',
      { waitUntil: 'domcontentloaded', timeout: 30000 },
    );
    await page.waitForTimeout(6000);

    if (!queryId) {
      await page.evaluate(() => window.scrollBy(0, 400));
      await page.waitForTimeout(3000);
    }
  } catch { /* timeout is ok, we just want to capture the API call */ }

  await page.close().catch(() => undefined);
  return queryId;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let cachedSession: LinkedInSession | null = null;

/**
 * Retorna uma sessão autenticada do LinkedIn.
 * Usa Playwright apenas para login e captura de tokens/QueryIDs.
 * Depois disso todas as requisições são feitas via HTTP.
 */
export async function getOrCreateSession(): Promise<LinkedInSession | null> {
  if (!hasLinkedInCredentials()) return null;

  if (cachedSession) {
    const valid = await validateSessionHttp(cachedSession);
    if (valid) return cachedSession;
    cachedSession = null;
  }

  const existing = loadSession();
  if (existing) {
    const valid = await validateSessionHttp(existing);
    if (valid) {
      console.log('  🍪 Sessão restaurada via arquivo.');
      cachedSession = existing;
      return existing;
    }
    console.log('  🍪 Sessão expirada, renovando...');
  }

  let browser: Browser | undefined;

  try {
    browser = await launchBrowser();
    let context = await createContext(browser);

    const authResult = await loginToLinkedIn(context);
    let sessionCookies: SessionCookie[];

    if (authResult === 'captcha_required') {
      await browser.close().catch(() => undefined);
      browser = undefined;

      const manual = await loginWithManualCaptcha();
      if (!manual.success || !manual.cookies) return null;

      sessionCookies = manual.cookies;

      browser = await launchBrowser();
      context = await createContext(browser);
      await context.addCookies(
        sessionCookies.map((c) => ({ ...c, sameSite: 'None' as const })),
      );
    } else if (authResult === 'authenticated') {
      const rawCookies = await context.cookies();
      sessionCookies = playwrightCookiesToSession(rawCookies);
    } else {
      return null;
    }

    console.log('  🔍 Capturando endpoints Voyager...');
    const voyagerQueryId = await captureVoyagerQueryId(context);

    if (voyagerQueryId) {
      console.log(`  ✅ QueryID capturado: ${voyagerQueryId.substring(0, 40)}...`);
    } else {
      console.log('  ⚠️  QueryID não capturado (busca autenticada limitada à API guest).');
    }

    const csrfToken = extractCsrfToken(sessionCookies);

    const session: LinkedInSession = {
      cookies: sessionCookies,
      csrfToken,
      userAgent: LINKEDIN_USER_AGENT,
      voyagerQueryId,
      createdAt: Date.now(),
    };

    saveSessionToDisk(session);
    cachedSession = session;
    console.log('  💾 Sessão salva.');
    return session;
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

export function invalidateSession(): void {
  cachedSession = null;
  try {
    if (fs.existsSync(SESSION_PATH)) fs.unlinkSync(SESSION_PATH);
  } catch { /* ignore */ }
}
