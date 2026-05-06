import { scrapeJobHttp } from './linkedin-api';

export interface JobData {
  title: string;
  company: string;
  location: string;
  description: string;
  url: string;
}

/**
 * Faz o scraping de uma vaga específica do LinkedIn via HTTP + cheerio.
 */
export async function scrapeJob(url: string): Promise<JobData> {
  return scrapeJobHttp(url);
}

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
