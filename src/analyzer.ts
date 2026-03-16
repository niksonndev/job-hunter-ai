import fs from 'fs';
import path from 'path';
import type { JobData } from './scraper';
import OpenAI from 'openai';

export interface AnalysisResult {
  score: number; // 0 a 10
  relevant: boolean; // true se score >= 7
  reason: string; // 1-2 frases
  keywords: string[]; // exatamente 10 keywords ATS da vaga
}

const RESUME_PATH = path.join(process.cwd(), 'data', 'nikson-curriculo-pt.md');

let cachedResume: string | null = null;

function loadResume(): string {
  if (cachedResume) return cachedResume;
  const content = fs.readFileSync(RESUME_PATH, 'utf8');
  cachedResume = content;
  return content;
}

const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = [
  'Você é um especialista em recrutamento e ATS (Applicant Tracking Systems).',
  'Analise a compatibilidade entre o currículo e a vaga fornecidos.',
  'Responda SOMENTE com um objeto JSON válido, sem markdown, sem explicações.',
  'O JSON deve ter exatamente os campos: score (number 0-10), relevant (boolean), reason (string), keywords (array de 10 strings)',
].join('\n');

export async function analyzeJob(job: JobData): Promise<AnalysisResult> {
  const resumeText = loadResume();

  const userPrompt = [
    'CURRÍCULO:',
    resumeText,
    '',
    'VAGA:',
    `Título: ${job.title}`,
    `Empresa: ${job.company}`,
    `Descrição: ${job.description}`,
  ].join('\n');

  const response = await openaiClient.chat.completions.create({
    model: 'gpt-4.1-mini',
    messages: [
      {
        role: 'system',
        content: SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: userPrompt,
      },
    ],
    temperature: 0,
  });

  const raw = response.choices[0]?.message?.content ?? '';

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Loga resposta bruta para debug
    console.error('Falha ao fazer JSON.parse da resposta do modelo:', raw);
    throw err;
  }

  const { score, relevant, reason, keywords } = parsed ?? {};

  if (typeof score !== 'number') {
    throw new Error('Campo "score" ausente ou inválido na resposta do modelo.');
  }

  if (typeof reason !== 'string') {
    throw new Error('Campo "reason" ausente ou inválido na resposta do modelo.');
  }

  if (!Array.isArray(keywords) || keywords.length !== 10 || !keywords.every((k) => typeof k === 'string')) {
    throw new Error('Campo "keywords" deve ser um array de exatamente 10 strings.');
  }

  // Garante a regra de negócio: relevant = score >= 7
  const normalizedRelevant = score >= 7;

  return {
    score,
    relevant: normalizedRelevant,
    reason,
    keywords,
  };
}

// Mini CLI para testar o passo a passo:
// npx ts-node -r dotenv/config src/analyzer.ts "<URL_DA_VAGA>"
if (require.main === module) {
  (async () => {
    const url = process.argv[2];

    if (!url) {
      console.error('Uso: ts-node -r dotenv/config src/analyzer.ts "<URL_DA_VAGA>"');
      process.exit(1);
    }

    const { scrapeJob } = await import('./scraper');

    try {
      const job = await scrapeJob(url);
      const analysis = await analyzeJob(job);
      console.log(JSON.stringify(analysis, null, 2));
    } catch (err) {
      console.error('Erro ao analisar vaga:', err);
      process.exit(1);
    }
  })();
}
