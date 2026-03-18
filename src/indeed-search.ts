import { chromium as stealthChromium } from 'playwright-extra';
import { chromium, Browser, BrowserContext, Page } from 'playwright';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { execSync, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
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

// ---------------------------------------------------------------------------
// Chrome standalone (sem Playwright, sem CDP, sem automação)
// ---------------------------------------------------------------------------

function findChromePath(): string | null {
  if (process.platform === 'darwin') {
    const p = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(p)) return p;
  }

  if (process.platform === 'win32') {
    const dirs = [
      process.env['PROGRAMFILES'] || '',
      process.env['PROGRAMFILES(X86)'] || '',
      process.env['LOCALAPPDATA'] || '',
    ];
    for (const dir of dirs) {
      const p = path.join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe');
      if (fs.existsSync(p)) return p;
    }
  }

  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium']) {
    try {
      const cmd = process.platform === 'win32' ? `where ${name}` : `which ${name}`;
      const p = execSync(`${cmd} 2>/dev/null`, { encoding: 'utf-8' }).trim();
      if (p) return p;
    } catch { continue; }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Cookie extraction from Chrome's SQLite database
// ---------------------------------------------------------------------------

function findCookieDbPath(): string | null {
  const candidates = [
    path.join(CHROME_PROFILE_PATH, 'Default', 'Network', 'Cookies'),
    path.join(CHROME_PROFILE_PATH, 'Default', 'Cookies'),
    path.join(CHROME_PROFILE_PATH, 'Network', 'Cookies'),
    path.join(CHROME_PROFILE_PATH, 'Cookies'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log(`  📂 Cookie DB encontrado: ${p}`);
      return p;
    }
  }
  console.log(`  ⚠️  Cookie DB não encontrado. Caminhos testados:`);
  for (const p of candidates) {
    console.log(`      ${p}`);
  }
  // Listar o conteúdo do perfil para debug
  try {
    const profileDefault = path.join(CHROME_PROFILE_PATH, 'Default');
    if (fs.existsSync(profileDefault)) {
      const entries = fs.readdirSync(profileDefault).slice(0, 20);
      console.log(`  📂 Conteúdo de Default/: ${entries.join(', ')}`);
    } else {
      const entries = fs.readdirSync(CHROME_PROFILE_PATH).slice(0, 20);
      console.log(`  📂 Conteúdo do perfil: ${entries.join(', ')}`);
    }
  } catch { /* ignore */ }
  return null;
}

let _cachedDecryptionKey: Buffer | null = null;

/**
 * Windows: Chrome usa AES-256-GCM com chave armazenada no Local State,
 * criptografada com DPAPI. Precisamos chamar PowerShell para descriptografar.
 */
function getWindowsChromeKey(): Buffer {
  const localStatePath = path.join(CHROME_PROFILE_PATH, 'Local State');
  if (!fs.existsSync(localStatePath)) {
    throw new Error(`Local State não encontrado: ${localStatePath}`);
  }

  const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf-8'));
  const encryptedKeyB64: string = localState?.os_crypt?.encrypted_key;
  if (!encryptedKeyB64) {
    throw new Error('encrypted_key não encontrada no Local State');
  }

  const encryptedKeyFull = Buffer.from(encryptedKeyB64, 'base64');
  // Remove o prefixo "DPAPI" (5 bytes)
  const encryptedKey = encryptedKeyFull.subarray(5);
  const encryptedKeyB64Clean = encryptedKey.toString('base64');

  const psScript = `
    Add-Type -AssemblyName System.Security
    $encrypted = [Convert]::FromBase64String("${encryptedKeyB64Clean}")
    $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $encrypted, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    [Convert]::ToBase64String($decrypted)
  `.trim();

  const result = execSync(
    `powershell -NoProfile -NonInteractive -Command "${psScript.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`,
    { encoding: 'utf-8' },
  ).trim();

  return Buffer.from(result, 'base64');
}

function getChromeDecryptionKey(): Buffer {
  if (_cachedDecryptionKey) return _cachedDecryptionKey;

  if (process.platform === 'win32') {
    _cachedDecryptionKey = getWindowsChromeKey();
  } else if (process.platform === 'darwin') {
    const password = execSync(
      'security find-generic-password -s "Chrome Safe Storage" -w',
      { encoding: 'utf-8' },
    ).trim();
    _cachedDecryptionKey = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  } else {
    _cachedDecryptionKey = crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
  }

  return _cachedDecryptionKey;
}

function decryptChromeValue(encryptedValue: Buffer): string {
  if (!encryptedValue || encryptedValue.length === 0) return '';

  const prefix = encryptedValue.subarray(0, 3).toString('utf-8');
  if (prefix !== 'v10' && prefix !== 'v11' && prefix !== 'v20') {
    return encryptedValue.toString('utf-8');
  }

  if (process.platform === 'win32') {
    // Windows Chrome v80+: v10 + nonce(12) + ciphertext + tag(16) → AES-256-GCM
    const nonce = encryptedValue.subarray(3, 3 + 12);
    const ciphertextWithTag = encryptedValue.subarray(3 + 12);
    const tag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);
    const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);

    const key = getChromeDecryptionKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  }

  // Linux/macOS: v10 + ciphertext → AES-128-CBC
  const encrypted = encryptedValue.subarray(3);
  const key = getChromeDecryptionKey();
  const iv = Buffer.alloc(16, ' ');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf-8');
}

const SAMESITE_MAP: Record<number, 'Strict' | 'Lax' | 'None'> = {
  0: 'None',
  1: 'Lax',
  2: 'Strict',
};

const CHROME_EPOCH_OFFSET = 11644473600n;

function extractCookiesFromChromeProfile(): any[] | null {
  const dbPath = findCookieDbPath();
  if (!dbPath) return null;

  try {
    // Copiar DB para evitar problemas de lock/WAL
    const tmpDb = dbPath + '.tmp';
    fs.copyFileSync(dbPath, tmpDb);
    // Copiar WAL e SHM se existirem
    if (fs.existsSync(dbPath + '-wal')) fs.copyFileSync(dbPath + '-wal', tmpDb + '-wal');
    if (fs.existsSync(dbPath + '-shm')) fs.copyFileSync(dbPath + '-shm', tmpDb + '-shm');

    const db = new Database(tmpDb, { readonly: true });

    // Debug: ver total de cookies e hosts disponíveis
    const totalCount = (db.prepare('SELECT COUNT(*) as c FROM cookies').get() as any)?.c || 0;
    console.log(`  📊 Total de cookies no DB: ${totalCount}`);

    if (totalCount > 0) {
      const hosts = db.prepare(
        `SELECT DISTINCT host_key FROM cookies ORDER BY host_key`,
      ).all() as any[];
      const indeedHosts = hosts.filter((h: any) => h.host_key.includes('indeed'));
      console.log(`  📊 Hosts indeed encontrados: ${indeedHosts.length > 0 ? indeedHosts.map((h: any) => h.host_key).join(', ') : 'NENHUM'}`);

      if (indeedHosts.length === 0) {
        const sampleHosts = hosts.slice(0, 10).map((h: any) => h.host_key);
        console.log(`  📊 Amostra de hosts: ${sampleHosts.join(', ')}`);
      }
    }

    const rows = db.prepare(
      `SELECT host_key, name, value, encrypted_value, path, expires_utc,
              is_secure, is_httponly, samesite
       FROM cookies WHERE host_key LIKE '%indeed%'`,
    ).all() as any[];
    db.close();

    // Limpeza dos arquivos temporários
    try { fs.unlinkSync(tmpDb); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpDb + '-wal'); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpDb + '-shm'); } catch { /* ignore */ }

    console.log(`  📊 Cookies do Indeed no DB: ${rows.length}`);

    if (rows.length === 0) return null;

    const cookies: any[] = [];
    for (const row of rows) {
      let cookieValue = row.value;
      if (!cookieValue && row.encrypted_value) {
        try {
          cookieValue = decryptChromeValue(row.encrypted_value);
        } catch (err) {
          console.log(`  ⚠️  Falha ao descriptografar cookie ${row.name}: ${(err as Error).message}`);
          cookieValue = '';
        }
      }

      if (!cookieValue) continue;

      const expiresUtc = BigInt(row.expires_utc || 0);
      const expires = expiresUtc > 0n
        ? Number(expiresUtc / 1000000n - CHROME_EPOCH_OFFSET)
        : -1;

      cookies.push({
        name: row.name,
        value: cookieValue,
        domain: row.host_key,
        path: row.path,
        expires,
        secure: !!row.is_secure,
        httpOnly: !!row.is_httponly,
        sameSite: SAMESITE_MAP[row.samesite] || 'None',
      });
    }

    return cookies;
  } catch (err) {
    console.log(`  ⚠️  Erro ao ler cookies do Chrome: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Abre Chrome como processo totalmente independente para login manual.
 *
 * O Cloudflare Turnstile 2026 detecta qualquer presença de CDP:
 * - Playwright (mesmo com Chrome real) → erro 600010
 * - --remote-debugging-port ativo → erro 600010
 * - DevTools aberto → erro 600010
 *
 * Solução: Chrome roda sem NENHUMA flag de automação/debug.
 * Após o usuário fazer login e fechar o Chrome, extraímos cookies
 * direto do banco SQLite do perfil do Chrome.
 */
async function loginIndeedManual(): Promise<boolean> {
  console.log('');
  console.log('  🖥️  Abrindo Chrome para login manual no Indeed...');
  console.log('  ℹ️  Faça login na janela que será aberta (Google, Apple ou código por email).');
  console.log('  ℹ️  Após fazer login, FECHE O CHROME para continuar.');

  const chromePath = findChromePath();
  if (!chromePath) {
    console.log('  ❌ Chrome não encontrado. Instale o Google Chrome e tente novamente.');
    return false;
  }

  fs.mkdirSync(CHROME_PROFILE_PATH, { recursive: true });

  try {
    const chromeProcess = spawn(chromePath, [
      `--user-data-dir=${CHROME_PROFILE_PATH}`,
      '--no-first-run',
      '--no-default-browser-check',
      INDEED_LOGIN_URL,
    ], { stdio: 'ignore', detached: false });

    console.log('  ⏳ Aguardando você fazer login e fechar o Chrome...');

    await new Promise<void>((resolve) => {
      chromeProcess.on('exit', () => resolve());
    });

    console.log('  🔍 Chrome fechado. Extraindo cookies do perfil...');

    const cookies = extractCookiesFromChromeProfile();
    if (cookies && cookies.length > 0) {
      saveCookies(cookies);
      console.log(`  🍪 ${cookies.length} cookies do Indeed extraídos e salvos.`);
      return true;
    }

    console.log('  ⚠️  Nenhum cookie do Indeed encontrado no perfil.');
    console.log('  ℹ️  Certifique-se de ter feito login no Indeed antes de fechar o Chrome.');
    return false;
  } catch (err: any) {
    console.log(`  ❌ Erro no login manual: ${err?.message ?? String(err)}`);
    return false;
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
