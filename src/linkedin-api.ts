import { load as cheerioLoad } from 'cheerio';
import type { LinkedInSession } from './linkedin-session';
import { buildCookieHeader } from './linkedin-session';
import type { JobData } from './scraper';

const LINKEDIN_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const GUEST_SEARCH_API =
  'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';

const VOYAGER_BASE = 'https://www.linkedin.com/voyager/api';

const GUEST_PAGE_SIZE = 10;
const AUTH_PAGE_SIZE = 25;
const GUEST_DELAY_MS = 800;
const AUTH_DELAY_MS = 1500;

const MAX_RETRIES = 3; // Increased from 2 for production resilience

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  const jitter = Math.floor(Math.random() * 600);
  return new Promise((r) => setTimeout(r, ms + jitter));
}

function guestHeaders(): Record<string, string> {
  return {
    'User-Agent': LINKEDIN_USER_AGENT,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    Connection: 'keep-alive',
  };
}

function voyagerHeaders(session: LinkedInSession): Record<string, string> {
  return {
    'User-Agent': session.userAgent,
    Accept: 'application/vnd.linkedin.normalized+json+2.1',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    Cookie: buildCookieHeader(session),
    'csrf-token': session.csrfToken,
    'x-li-lang': 'pt_BR',
    'x-li-track': JSON.stringify({
      clientVersion: '1.13.8977',
      mpVersion: '1.13.8977',
      osName: 'web',
      timezoneOffset: -3,
      timezone: 'America/Sao_Paulo',
      deviceFormFactor: 'DESKTOP',
      mpName: 'voyager-web',
      displayDensity: 1,
      displayWidth: 1920,
      displayHeight: 1080,
    }),
    'x-restli-protocol-version': '2.0.0',
  };
}

function buildSearchParams(query: string): URLSearchParams {
  return new URLSearchParams({
    keywords: query,
    location: 'Brazil',
    f_WT: '2',
    f_E: '2,3',
  });
}

/**
 * PRODUCTION: Resilient retry logic with exponential backoff + jitter
 * Handles rate limits (429), server errors (5xx), and network issues
 */
async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  retries = MAX_RETRIES,
): Promise<Response> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(15000), // 15s timeout
      });

      // Check for retryable HTTP status codes
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt < retries) {
          // Exponential backoff: 500ms, 1s, 2s, 4s with ±10% jitter
          const baseDelay = 500 * Math.pow(2, attempt);
          const jitter = Math.random() * baseDelay * 0.1; // ±10%
          const totalDelay = baseDelay + jitter;
          
          console.log(`   ⏳ Retry ${attempt + 1}/${retries} after ${totalDelay.toFixed(0)}ms (HTTP ${res.status})`);
          await sleep(totalDelay);
          continue;
        }
      }

      return res;
    } catch (err: any) {
      lastError = err;

      // Check if error is retryable
      const isRetryable =
        err?.name === 'AbortError' ||
        err?.code === 'ECONNRESET' ||
        err?.code === 'ETIMEDOUT' ||
        err?.code === 'ENOTFOUND';

      if (isRetryable && attempt < retries) {
        const baseDelay = 500 * Math.pow(2, attempt);
        const jitter = Math.random() * baseDelay * 0.1;
        const totalDelay = baseDelay + jitter;
        
        console.log(`   ⏳ Retry ${attempt + 1}/${retries} after ${totalDelay.toFixed(0)}ms (${err?.code || err?.name})`);
        await sleep(totalDelay);
        continue;
      }
    }
  }

  throw (
    lastError ?? 
    new Error(`Failed after ${retries + 1} attempts: ${url}`)
  );
}

// ---------------------------------------------------------------------------
// HTML parsing
// ---------------------------------------------------------------------------

function extractJobIdsFromHtml(html: string): string[] {
  const $ = cheerioLoad(html);
  const ids: string[] = [];
  const seen = new Set<string>();

  $('a[href*="/jobs/view/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const match = href.match(/\/jobs\/view\/(\d+)/);
    if (match && !seen.has(match[1])) {
      seen.add(match[1]);
      ids.push(match[1]);
    }
  });

  $('a.base-card__full-link').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    try {
      const parsed = new URL(href, 'https://www.linkedin.com');
      const seg = parsed.pathname.split('/').filter(Boolean).pop();
      if (!seg) return;
      const id = seg.split('-').pop();
      if (id && /^\d+$/.test(id) && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    } catch { /* ignore malformed URLs */ }
  });

  return ids;
}

function extractJobIdsFromVoyagerJson(json: unknown): { ids: string[]; total: number } {
  const text = JSON.stringify(json);
  const seen = new Set<string>();
  const ids: string[] = [];

  const patterns = [
    /urn:li:fs_normalized_jobPosting:(\d+)/g,
    /urn:li:fsd_jobPostingCard:\((\d+),/g,
    /urn:li:fsd_jobPosting:(\d+)/g,
    /\/jobs\/view\/(\d+)/g,
    /"jobPostingId":(\d+)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (!seen.has(match[1])) {
        seen.add(match[1]);
        ids.push(match[1]);
      }
    }
  }

  let total = 0;
  const obj = json as any;
  const paging =
    obj?.paging ?? obj?.data?.paging ?? obj?.data?.jobCardsByJobSearch?.paging;
  if (paging?.total && typeof paging.total === 'number') {
    total = paging.total;
  }

  return { ids, total: total || ids.length };
}

// ---------------------------------------------------------------------------
// Guest search via HTTP
// ---------------------------------------------------------------------------

export async function searchGuestHttp(
  query: string,
  maxResults: number,
): Promise<string[]> {
  const allIds = new Set<string>();
  let consecutiveEmpty = 0;

  for (let start = 0; start < maxResults; start += GUEST_PAGE_SIZE) {
    const params = buildSearchParams(query);
    params.set('start', String(start));
    const url = `${GUEST_SEARCH_API}?${params.toString()}`;

    try {
      const res = await fetchWithRetry(url, guestHeaders());

      if (!res.ok) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) break;
        await sleep(2000);
        continue;
      }

      const html = await res.text();
      const pageIds = extractJobIdsFromHtml(html);

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
    } catch {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) break;
    }

    await sleep(GUEST_DELAY_MS);
  }

  return Array.from(allIds);
}

// ---------------------------------------------------------------------------
// Authenticated search via Voyager API (HTTP)
// ---------------------------------------------------------------------------

function buildVoyagerSearchUrl(
  session: LinkedInSession,
  query: string,
  start: number,
  count: number,
): string | null {
  if (!session.voyagerQueryId) return null;

  const encodedKeywords = encodeURIComponent(query);
  const locationFilter = 'locationUnion:(geoId:106057199)';
  const expFilter = 'selectedFilters:(experience:List(2,3),workplaceType:List(2))';
  const queryPart = `(origin:JOB_SEARCH_PAGE_QUERY_EXPANSION,keywords:${encodedKeywords},${locationFilter},${expFilter})`;

  if (session.voyagerQueryId.startsWith('decoration:')) {
    const decorationId = session.voyagerQueryId.replace('decoration:', '');
    return (
      `${VOYAGER_BASE}/voyagerJobsDashJobCards` +
      `?decorationId=${encodeURIComponent(decorationId)}` +
      `&count=${count}` +
      `&q=jobSearch` +
      `&query=${queryPart}` +
      `&start=${start}`
    );
  }

  return (
    `${VOYAGER_BASE}/graphql` +
    `?variables=(start:${start},count:${count},query:${queryPart})` +
    `&queryId=${session.voyagerQueryId}`
  );
}

export interface VoyagerSearchResult {
  ids: string[];
  sessionExpired: boolean;
}

export async function searchAuthenticatedHttp(
  session: LinkedInSession,
  query: string,
  maxResults: number,
): Promise<VoyagerSearchResult> {
  if (!session.voyagerQueryId) {
    console.log('  ⚠️  Voyager QueryID não disponível, pulando busca autenticada.');
    return { ids: [], sessionExpired: false };
  }

  const allIds = new Set<string>();
  let consecutiveEmpty = 0;
  let sessionExpired = false;

  for (let start = 0; start < maxResults; start += AUTH_PAGE_SIZE) {
    const url = buildVoyagerSearchUrl(session, query, start, AUTH_PAGE_SIZE);
    if (!url) break;

    try {
      const res = await fetchWithRetry(url, voyagerHeaders(session), 1);

      if (res.status === 401 || res.status === 403) {
        console.log(`  ⚠️  Sessão expirada (HTTP ${res.status}).`);
        sessionExpired = true;
        break;
      }

      if (!res.ok) {
        console.log(`  ⚠️  Voyager HTTP ${res.status} em start=${start}`);
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) break;
        await sleep(3000);
        continue;
      }

      const json = await res.json();
      const { ids: pageIds, total } = extractJobIdsFromVoyagerJson(json);

      const sizeBefore = allIds.size;
      for (const id of pageIds) allIds.add(id);
      const newCount = allIds.size - sizeBefore;

      console.log(
        `  📄 Voyager start=${start}: ${pageIds.length} cards, ${newCount} novos` +
        `${total > 0 ? ` (total API: ${total})` : ''} [acumulado: ${allIds.size}]`,
      );

      if (pageIds.length === 0 || newCount === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) break;
      } else {
        consecutiveEmpty = 0;
      }

      if (total > 0 && allIds.size >= total) break;
    } catch (err: any) {
      console.log(`  ⚠️  Erro Voyager start=${start}: ${err?.message ?? err}`);
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) break;
    }

    await sleep(AUTH_DELAY_MS);
  }

  return { ids: Array.from(allIds), sessionExpired };
}

// ---------------------------------------------------------------------------
// Authenticated search fallback: HTML pages with auth cookies
// ---------------------------------------------------------------------------

export async function searchAuthenticatedHtmlHttp(
  session: LinkedInSession,
  query: string,
  maxResults: number,
): Promise<VoyagerSearchResult> {
  const allIds = new Set<string>();
  let consecutiveEmpty = 0;
  let sessionExpired = false;

  const headers: Record<string, string> = {
    'User-Agent': session.userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    Cookie: buildCookieHeader(session),
  };

  for (let start = 0; start < maxResults; start += AUTH_PAGE_SIZE) {
    const params = buildSearchParams(query);
    params.set('start', String(start));
    const url = `https://www.linkedin.com/jobs/search/?${params.toString()}`;

    try {
      const res = await fetchWithRetry(url, headers, 1);

      if (res.status === 401 || res.status === 403) {
        sessionExpired = true;
        break;
      }

      if (res.url.includes('/login')) {
        sessionExpired = true;
        break;
      }

      if (!res.ok) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) break;
        await sleep(3000);
        continue;
      }

      const html = await res.text();
      const pageIds = extractJobIdsFromHtml(html);

      const sizeBefore = allIds.size;
      for (const id of pageIds) allIds.add(id);
      const newCount = allIds.size - sizeBefore;

      console.log(
        `  📄 Auth HTML start=${start}: ${pageIds.length} cards, ${newCount} novos [acumulado: ${allIds.size}]`,
      );

      if (pageIds.length === 0 || newCount === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) break;
      } else {
        consecutiveEmpty = 0;
      }
    } catch {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 3) break;
    }

    await sleep(AUTH_DELAY_MS);
  }

  return { ids: Array.from(allIds), sessionExpired };
}

// ---------------------------------------------------------------------------
// Job page scraping via HTTP + cheerio
// ---------------------------------------------------------------------------

export async function scrapeJobHttp(url: string): Promise<JobData> {
  const res = await fetchWithRetry(url, guestHeaders());

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ao buscar ${url}`);
  }

  const html = await res.text();
  return parseJobPageHtml(html, url);
}

function parseJobPageHtml(html: string, url: string): JobData {
  const $ = cheerioLoad(html);

  const rawTitle =
    $('h1.top-card-layout__title').text() ||
    $('h2.top-card-layout__title').text() ||
    $('h1.topcard__title').text() ||
    $('h1').first().text();

  const rawCompany =
    $('a.topcard__org-name-link').text() ||
    $('span.topcard__flavor a').text() ||
    $('a[data-tracking-control-name="public_jobs_topcard-org-name"]').text();

  const rawLocation =
    $('span.topcard__flavor--bullet').text() ||
    $('span.topcard__flavor:not(:has(a))').text();

  let rawDescription =
    $('div.description__text').text() ||
    $('div.show-more-less-html__markup').text() ||
    $('section.description .core-section-container__content').text() ||
    $('div.description').text();

  const title = rawTitle.trim();
  const company = rawCompany.trim();
  const location = rawLocation.trim();
  const description = rawDescription
    .replace(/\s*Show more\s*/gi, '')
    .replace(/\s*Show less\s*/gi, '')
    .replace(/\s*Mostrar mais\s*/gi, '')
    .replace(/\s*Mostrar menos\s*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, company, location, description, url };
}
