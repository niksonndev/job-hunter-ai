import 'dotenv/config';

import { scrapeJob } from './scraper';
import { analyzeJob } from './analyzer';
import { adaptResume } from './adapter';
// composeEmail é opcional; atualmente não é usado no fluxo principal
// import { composeEmail } from './composer';
import { searchJobs, SEARCH_KEYWORDS, SearchCategory } from './search';
import { saveJobUrl, saveJobDetails } from './storage';

const requiredEnvVars = ['OPENAI_API_KEY'] as const;

for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${key}`);
  }
}

async function processSearchQuery(rawQuery: string, limit?: number) {
  const query = rawQuery.trim();

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

      saveJobDetails(job.url, job, analysis);

      console.log('✍️  Adaptando currículo...');
      await adaptResume(job, analysis);

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

async function main() {
  const [mode, ...rest] = process.argv.slice(2);

  if (!mode) {
    console.log('Nenhum argumento informado. Rodando buscas padrão em lote (SEARCH_KEYWORDS).');

    const defaultLimitEnv = process.env.DEFAULT_SEARCH_LIMIT;
    const defaultLimit =
      defaultLimitEnv && !Number.isNaN(Number(defaultLimitEnv)) && Number(defaultLimitEnv) > 0
        ? Math.floor(Number(defaultLimitEnv))
        : undefined;

    const categories = Object.keys(SEARCH_KEYWORDS) as SearchCategory[];
    for (const category of categories) {
      console.log(`\n🏷️  Categoria: ${category}`);
      const keywords = SEARCH_KEYWORDS[category];
      for (const [key, label] of Object.entries(keywords)) {
        console.log('\n==================================================');
        console.log(`▶ [${category}] ${key} → "${label}"`);
        await processSearchQuery(key, defaultLimit);
      }
    }

    console.log('\n✅ Execução das buscas padrão concluída.');
    return;
  }

  // Comando por categoria: frontend, backend, fullstack, webAnalytics
  const categoryKeys = Object.keys(SEARCH_KEYWORDS) as SearchCategory[];
  const matchedCategory = categoryKeys.find((c) => c.toLowerCase() === mode.toLowerCase());
  if (matchedCategory) {
    const defaultLimitEnv = process.env.DEFAULT_SEARCH_LIMIT;
    const defaultLimit =
      defaultLimitEnv && !Number.isNaN(Number(defaultLimitEnv)) && Number(defaultLimitEnv) > 0
        ? Math.floor(Number(defaultLimitEnv))
        : undefined;

    console.log(`🏷️  Rodando categoria: ${matchedCategory}`);
    const keywords = SEARCH_KEYWORDS[matchedCategory];
    for (const [key, label] of Object.entries(keywords)) {
      console.log('\n==================================================');
      console.log(`▶ [${matchedCategory}] ${key} → "${label}"`);
      await processSearchQuery(key, defaultLimit);
    }
    console.log(`\n✅ Categoria ${matchedCategory} concluída.`);
    return;
  }

  const SEARCH_MODES = ['search', 'busca'];

  // Processar uma única URL de vaga
  if (!SEARCH_MODES.includes(mode)) {
    const jobUrl = mode;

    console.log('🔍 Buscando vaga única...');
    const job = await scrapeJob(jobUrl);

    console.log('📊 Analisando compatibilidade...');
    const analysis = await analyzeJob(job);

    if (!analysis.relevant) {
      console.log(`⚠️  Vaga não relevante (score: ${analysis.score}/10): ${analysis.reason} — encerrando.`);
      return;
    }

    saveJobUrl(job.url);
    saveJobDetails(job.url, job, analysis);

    console.log('✍️  Adaptando currículo...');
    await adaptResume(job, analysis);

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

  // Busca + processamento em lote
  let limit: number | undefined;
  let queryParts = rest;

  if (rest.length > 0) {
    const maybeLimit = Number(rest[0]);
    if (!Number.isNaN(maybeLimit) && Number.isFinite(maybeLimit) && maybeLimit > 0) {
      limit = Math.floor(maybeLimit);
      queryParts = rest.slice(1);
    }
  }

  if (limit === undefined) {
    const defaultLimitEnv = process.env.DEFAULT_SEARCH_LIMIT;
    if (defaultLimitEnv && !Number.isNaN(Number(defaultLimitEnv)) && Number(defaultLimitEnv) > 0) {
      limit = Math.floor(Number(defaultLimitEnv));
    }
  }

  const query = queryParts.join(' ').trim();
  if (!query) {
    console.error(
      'Erro: informe o termo de busca.\n' +
      'Exemplos:\n' +
      '  npm run dev -- search "React Developer"\n' +
      '  npm run dev -- search 10 "React Developer"   (com limite)',
    );
    process.exit(1);
  }

  await processSearchQuery(query, limit);
}

main().catch((err) => {
  console.error('Erro na execução do job-agent:', err);
  process.exitCode = 1;
});
