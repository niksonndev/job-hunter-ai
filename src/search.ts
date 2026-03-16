import { chromium, Browser, Page } from 'playwright';

const LINKEDIN_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

const LINKEDIN_JOBS_SEARCH_URL = 'https://www.linkedin.com/jobs/search/';

function buildSearchUrl(query: string, start = 0): string {
  const params = new URLSearchParams({
    keywords: query,
    location: 'Brazil',
    f_TPR: 'r2592000', // últimos 30 dias
    f_WT: '2', // remoto
    f_E: '2,3', // pleno + sênior
    f_JT: 'F', // full-time
    start: String(start),
  });

  return `${LINKEDIN_JOBS_SEARCH_URL}?${params.toString()}`;
}

/**
 * Faz uma busca pública de vagas no LinkedIn e retorna
 * uma lista de URLs das vagas encontradas.
 */
export async function searchJobs(query: string): Promise<string[]> {
  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    browser = await chromium.launch({
      headless: false,
    });

    const context = await browser.newContext({
      userAgent: LINKEDIN_USER_AGENT,
    });

    page = await context.newPage();

    const searchUrl = buildSearchUrl(query);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Garante que pelo menos um card de vaga apareceu
    await page.waitForSelector('a.base-card__full-link', { timeout: 15000 });

    const jobUrls = await page.$$eval('a.base-card__full-link', (links) => {
      const canonicalUrls: string[] = [];

      for (const link of links) {
        if (!(link instanceof HTMLAnchorElement)) continue;
        const rawHref = link.href;
        if (!rawHref || !rawHref.includes('/jobs/view/')) continue;

        try {
          const url = new URL(rawHref);
          const path = url.pathname; // ex: /jobs/view/desenvolvedor-backend-...-4376442472
          const lastSegment = path.split('/').filter(Boolean).pop();
          if (!lastSegment) continue;

          const id = lastSegment.split('-').pop();
          if (!id || !/^\d+$/.test(id)) continue;

          const canonical = `https://www.linkedin.com/jobs/view/${id}`;
          if (!canonicalUrls.includes(canonical)) {
            canonicalUrls.push(canonical);
          }
        } catch {
          // ignora hrefs inválidos
          continue;
        }
      }

      return canonicalUrls;
    });

    return jobUrls;
  } finally {
    if (page) {
      await page.close().catch(() => undefined);
    }
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

