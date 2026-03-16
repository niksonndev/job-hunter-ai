import 'dotenv/config';

import { scrapeJob } from './scraper';
import { analyzeJob } from './analyzer';
import { adaptResume } from './adapter';
import { composeEmail } from './composer';

const requiredEnvVars = ['OPENAI_API_KEY'] as const;

for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${key}`);
  }
}

async function main() {
  const jobUrl = process.argv[2];

  if (!jobUrl) {
    console.error('Erro: informe a URL da vaga como argumento. Ex: npm run dev -- "<URL_DA_VAGA>"');
    process.exit(1);
  }

  console.log('🔍 Buscando vaga...');
  const job = await scrapeJob(jobUrl);

  console.log('📊 Analisando compatibilidade...');
  const analysis = await analyzeJob(job);

  if (!analysis.relevant) {
    console.log(`⚠️  Vaga não relevante (score: ${analysis.score}/10): ${analysis.reason} — encerrando.`);
    return;
  }

  console.log('✍️  Adaptando currículo...');
  const adapted = await adaptResume(job, analysis);

  console.log('📧 Gerando email...');
  const email = await composeEmail(job, analysis);

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
}

main().catch((err) => {
  console.error('Erro na execução do job-agent:', err);
  process.exitCode = 1;
});
