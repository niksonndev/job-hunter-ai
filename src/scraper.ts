import { chromium, Browser, Page } from 'playwright';

export interface JobData {
  title: string;
  company: string;
  location: string;
  description: string;
  url: string;
}

const LINKEDIN_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

/**
 * Faz o scraping de uma vaga específica do LinkedIn, recebendo apenas a URL da vaga.
 * Não faz busca/listagem, apenas extrai os campos relevantes da página.
 */
export async function scrapeJob(url: string): Promise<JobData> {
  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    browser = await chromium.launch({
      headless: true,
    });

    const context = await browser.newContext({
      userAgent: LINKEDIN_USER_AGENT,
    });

    page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });

    // Aguarda o elemento crítico carregar
    await page.waitForSelector('h1.top-card-layout__title');

    const rawTitle = await page.textContent('h1.top-card-layout__title');
    const rawCompany = await page.textContent('a.topcard__org-name-link');
    const rawLocation = await page.textContent('span.topcard__flavor--bullet');
    const rawDescription = await page.evaluate(() => {
      const el = document.querySelector('div.description__text');
      return el ? (el as HTMLElement).innerText : '';
    });

    const title = rawTitle?.trim() ?? '';
    const company = rawCompany?.trim() ?? '';
    const location = rawLocation?.trim() ?? '';
    const description =
      rawDescription
        ?.replace(/\s*Show more\s*/gi, '')
        .replace(/\s*Show less\s*/gi, '')
        .replace(/\n{3,}/g, '\n\n') // colapsa linhas em branco excessivas
        .trim() ?? '';

    return {
      title,
      company,
      location,
      description,
      url,
    };
  } finally {
    // Garante que os recursos sejam liberados mesmo em caso de erro.
    if (page) {
      await page.close().catch(() => undefined);
    }
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

// Permite usar o arquivo como CLI:
// npx ts-node src/scraper.ts "<URL_DA_VAGA>"
if (require.main === module) {
  const url = process.argv[2];

  if (!url) {
    console.error('Uso: ts-node src/scraper.ts <URL_DA_VAGA>');
    process.exit(1);
  }

  scrapeJob(url)
    .then((job) => {
      console.log(JSON.stringify(job, null, 2));
    })
    .catch((err) => {
      console.error('Erro ao fazer scraping:', err);
      process.exit(1);
    });
}
