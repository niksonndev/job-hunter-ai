import 'dotenv/config';

import { scrapeJob } from './scraper';
import { analyzeJob } from './analyzer';
import { adaptResume } from './adapter';
import { composeEmail } from './composer';

const requiredEnvVars = ['ANTHROPIC_API_KEY'] as const;

for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${key}`);
  }
}

async function main() {
  // Orquestração mínima; implementação real virá depois.
  const jobUrl = '';
  const job = await scrapeJob(jobUrl);
  const analysis = analyzeJob(job, '');

  const adapted = adaptResume('', {
    jobTitle: job.title,
    jobDescription: job.description,
  });

  const email = composeEmail({
    jobTitle: job.title,
    adaptedResume: adapted.content,
  });

  console.log('Pipeline inicializado (sem lógica real ainda).', {
    job,
    analysis,
    adapted,
    email,
  });
}

main().catch((err) => {
  console.error('Erro na execução do job-agent:', err);
  process.exitCode = 1;
});
