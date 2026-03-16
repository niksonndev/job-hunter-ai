import 'dotenv/config';

import { scrapeJob } from './scraper';
import { analyzeJob } from './analyzer';
import { adaptResume } from './adapter';
import { composeEmail } from './composer';
import { searchJobs } from './search';
import { saveJobUrl, saveJobDetails } from './storage';

const requiredEnvVars = ['OPENAI_API_KEY'] as const;

for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${key}`);
  }
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);

  if (!mode) {
    console.error('Uso: npm run dev -- "<URL_DA_VAGA>"');
    console.error('   ou: npm run dev -- search [LIMITE_OPCIONAL] "<TERMO_DE_BUSCA>"');
    process.exit(1);
  }

  // Modo antigo: processar uma única URL de vaga
  if (!['search', 'busca'].includes(mode)) {
    const jobUrl = mode;

    console.log('🔍 Buscando vaga única...');
    const job = await scrapeJob(jobUrl);

    console.log('📊 Analisando compatibilidade...');
    const analysis = await analyzeJob(job);

    if (!analysis.relevant) {
      console.log(`⚠️  Vaga não relevante (score: ${analysis.score}/10): ${analysis.reason} — encerrando.`);
      return;
    }

    // persiste detalhes da vaga/análise no SQLite
    saveJobUrl(job.url);
    saveJobDetails(job.url, job, analysis);

    console.log('✍️  Adaptando currículo...');
    await adaptResume(job, analysis);

    console.log('📧 Gerando email...');
    await composeEmail(job, analysis);

    console.log('✅ Concluído! Arquivos gerados em data/outputs/');
    console.log('Resumo:', {
      job: {
        title: job.title,
        company: job.company,
        location: job.location,
        url: job.url,
      },
      analysis,
    });
    return;
  }

  // Novo modo: busca + processamento em lote
  let limit: number | undefined;
  let queryParts = rest;

  if (rest.length > 0) {
    const maybeLimit = Number(rest[0]);
    if (!Number.isNaN(maybeLimit) && Number.isFinite(maybeLimit) && maybeLimit > 0) {
      limit = Math.floor(maybeLimit);
      queryParts = rest.slice(1);
    }
  }

  const query = queryParts.join(' ').trim();
  if (!query) {
    console.error(
      'Erro: informe o termo de busca. Ex: npm run dev -- search \"desenvolvedor backend node\" ou npm run dev -- search 10 \"desenvolvedor backend node\"',
    );
    process.exit(1);
  }

  console.log(`🔎 Buscando vagas para: "${query}"...`);
  const allUrls = await searchJobs(query);
  const urls = typeof limit === 'number' ? allUrls.slice(0, limit) : allUrls;

  console.log(
    `🔗 ${allUrls.length} URLs encontradas. Serão processadas ${urls.length} vaga(s)${
      limit ? ` (limite configurado: ${limit})` : ''
    }.`,
  );

  for (const url of urls) {
    try {
      // Armazenamento + deduplicação
      const inserted = saveJobUrl(url);
      if (!inserted) {
        console.log(`⏭️  Vaga já processada, pulando: ${url}`);
        continue;
      }

      console.log(`\n🔍 Processando vaga: ${url}`);

      const job = await scrapeJob(url);

      console.log('📊 Analisando compatibilidade...');
      const analysis = await analyzeJob(job);

      if (!analysis.relevant) {
        console.log(`⚠️  Vaga não relevante (score: ${analysis.score}/10): ${analysis.reason} — pulando.`);
        continue;
      }

      // persiste detalhes da vaga/análise no SQLite
      saveJobDetails(job.url, job, analysis);

      console.log('✍️  Adaptando currículo...');
      await adaptResume(job, analysis);

      console.log('📧 Gerando email...');
      await composeEmail(job, analysis);

      console.log('✅ Vaga processada com sucesso!', {
        title: job.title,
        company: job.company,
        score: analysis.score,
        url: job.url,
      });
    } catch (err: any) {
      if (err && err.name === 'TimeoutError') {
        console.error(`⚠️ Erro de timeout ao carregar vaga ${url} — pulando.`);
      } else {
        console.error(`⚠️ Erro inesperado ao processar vaga ${url} — pulando.`, err);
      }
    }
  }
}

main().catch((err) => {
  console.error('Erro na execução do job-agent:', err);
  process.exitCode = 1;
});
