import { chromium, Browser, Page } from 'playwright';

const LINKEDIN_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const LINKEDIN_JOBS_SEARCH_URL = 'https://www.linkedin.com/jobs/search/';
const LINKEDIN_JOBS_API_URL =
  'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';

const API_PAGE_SIZE = 10;
const API_REQUEST_DELAY_MS = 800;

// Palavras-chave pré-definidas para buscas comuns no LinkedIn.
// A chave é um identificador "amigável" e o valor é a query enviada em `keywords`.
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
    f_WT: '2', // remoto
    f_E: '2,3', // pleno + sênior
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
  return baseMs + Math.floor(Math.random() * 400);
}

/**
 * Extrai IDs de vagas dos links `base-card__full-link` presentes na página.
 */
async function extractJobIds(page: Page): Promise<string[]> {
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
      } catch {
        continue;
      }
    }
    return ids;
  });
}

/**
 * Faz uma busca pública de vagas no LinkedIn e retorna
 * uma lista de URLs das vagas encontradas.
 *
 * Usa a API guest de paginação do LinkedIn que retorna fragmentos HTML
 * com ~10 vagas por chamada e suporta paginação real via parâmetro `start`.
 */
export async function searchJobs(query: string): Promise<string[]> {
  const maxResults = getMaxSearchResults();
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: true });

    const context = await browser.newContext({
      userAgent: LINKEDIN_USER_AGENT,
      viewport: { width: 1920, height: 1080 },
      locale: 'pt-BR',
    });

    const page = await context.newPage();
    const allIds = new Set<string>();
    let consecutiveEmpty = 0;

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

      const pageIds = await extractJobIds(page);
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

    console.log(`  📄 Total: ${allIds.size} vagas únicas encontradas.`);

    await page.close().catch(() => undefined);
    return Array.from(allIds).map((id) => `https://www.linkedin.com/jobs/view/${id}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

// CLI opcional:
// npx ts-node src/search.ts "desenvolvedor backend node"
if (require.main === module) {
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

