import fs from 'fs';
import path from 'path';
import { scrapeJobHtml } from './scraper';

async function main(): Promise<void> {
  const url = process.argv[2];

  if (!url) {
    console.error('Uso: npm run debug:job -- "<URL_DA_VAGA>"');
    process.exit(1);
  }

  console.log(`🔎 Buscando vaga: ${url}`);
  const page = await scrapeJobHtml(url);

  const outDir = path.join(process.cwd(), 'data');
  const outFile = path.join(outDir, 'debug-job.html');

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, page.html, 'utf-8');

  console.log(`💾 HTML da vaga salvo em: ${outFile}`);
  console.log('📄 Preview do HTML:');
  console.log(page.html.slice(0, 4000));
}

main().catch((err) => {
  console.error('Erro ao depurar vaga:', err);
  process.exit(1);
});
