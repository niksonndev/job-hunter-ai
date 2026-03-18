import 'dotenv/config';

import { scrapeJob } from './scraper';
import { analyzeJob } from './analyzer';
import { adaptResume } from './adapter';
// composeEmail é opcional; atualmente não é usado no fluxo principal
// import { composeEmail } from './composer';
import { searchJobs, SEARCH_KEYWORDS, SearchCategory } from './search';
import { searchIndeedJobs, indeedLogin } from './indeed-search';
import { saveJobUrl, saveJobDetails } from './storage';

const requiredEnvVars = ['OPENAI_API_KEY'] as const;

for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${key}`);
  }
}

type SearchSource = 'all' | 'linkedin' | 'indeed';

async function processSearchQuery(rawQuery: string, limit?: number, source: SearchSource = 'all') {
  const query = rawQuery.trim();

  console.log(`🔎 Buscando vagas para: "${query}"...`);

  let linkedinUrls: string[] = [];
  let indeedUrls: string[] = [];

  if (source === 'all' || source === 'linkedin') {
    console.log('  🔍 Buscando no LinkedIn...');
    linkedinUrls = await searchJobs(query);
    console.log(`  📊 LinkedIn: ${linkedinUrls.length} vagas encontradas.`);
  }

  if (source === 'all' || source === 'indeed') {
    console.log('  🔍 Buscando no Indeed...');
    indeedUrls = await searchIndeedJobs(query);
    console.log(`  📊 Indeed: ${indeedUrls.length} vagas encontradas.`);
  }

  const allUrls = [...linkedinUrls, ...indeedUrls];
  const urls = typeof limit === 'number' ? allUrls.slice(0, limit) : allUrls;

  console.log(
    `🔗 ${allUrls.length} URLs encontradas${source === 'all' ? ` (LinkedIn: ${linkedinUrls.length}, Indeed: ${indeedUrls.length})` : ''}. Serão processadas ${urls.length} vaga(s)${
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
      // Opcional: se quiser gerar email de candidatura automaticamente,
      // reabilite a chamada abaixo e o import de composeEmail no topo.
      // console.log('📧 Gerando email...');
      // await composeEmail(job, analysis);

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

  // Comando indeed-login: abre Chrome para login manual no Indeed
  if (mode === 'indeed-login') {
    const success = await indeedLogin();
    if (success) {
      console.log('✅ Login no Indeed concluído. Cookies salvos.');
    } else {
      console.log('❌ Login no Indeed falhou.');
    }
    return;
  }

  const SEARCH_MODES = ['search', 'busca', 'linkedin', 'indeed'];

  // Modo antigo: processar uma única URL de vaga
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

    // persiste detalhes da vaga/análise no SQLite
    saveJobUrl(job.url);
    saveJobDetails(job.url, job, analysis);

    console.log('✍️  Adaptando currículo...');
    await adaptResume(job, analysis);
    // Opcional: se quiser gerar email de candidatura automaticamente,
    // reabilite a chamada abaixo e o import de composeEmail no topo.
    // console.log('📧 Gerando email...');
    // await composeEmail(job, analysis);

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

  // Determina a fonte de busca
  const source: SearchSource =
    mode === 'linkedin' ? 'linkedin' :
    mode === 'indeed' ? 'indeed' :
    'all';

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
      '  npm run dev -- search "React Developer"        (LinkedIn + Indeed)\n' +
      '  npm run dev -- linkedin "React Developer"       (apenas LinkedIn)\n' +
      '  npm run dev -- indeed "React Developer"         (apenas Indeed)\n' +
      '  npm run dev -- search 10 "React Developer"      (com limite)',
    );
    process.exit(1);
  }

  await processSearchQuery(query, limit, source);
}

main().catch((err) => {
  console.error('Erro na execução do job-agent:', err);
  process.exitCode = 1;
});
