import fs from 'fs';
import path from 'path';
import type { JobData } from './scraper';
import OpenAI from 'openai';

export interface AnalysisResult {
  score: number;
  relevant: boolean;
  reason: string;
  keywords: string[];
}

const RESUME_PATH =
  process.env.RESUME_PATH || path.join(process.cwd(), 'data', 'nikson-curriculo-generic.md');

const MAX_DESCRIPTION_CHARS = 6000;
const MAX_RETRIES = 2;
const MIN_KEYWORDS = 5;
const MAX_KEYWORDS = 15;
const RELEVANCE_THRESHOLD = 7;

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
  'Responda SOMENTE com um objeto JSON válido.',
  'O JSON deve ter exatamente os campos:',
  '  - score (number 0-10)',
  '  - reason (string curta, 1-2 frases)',
  `  - keywords (array de ${MIN_KEYWORDS} a ${MAX_KEYWORDS} strings — as keywords ATS mais relevantes da vaga)`,
].join('\n');

function truncateDescription(description: string): string {
  if (description.length <= MAX_DESCRIPTION_CHARS) return description;
  return description.slice(0, MAX_DESCRIPTION_CHARS) + '… [truncado]';
}

function stripMarkdownFences(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    if (firstNewline !== -1) {
      cleaned = cleaned.slice(firstNewline + 1);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();
  }
  return cleaned;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logTokenUsage(usage: OpenAI.Completions.CompletionUsage | undefined): void {
  if (!usage) return;
  const { prompt_tokens, completion_tokens, total_tokens } = usage;
  console.log(`   💰 Tokens — prompt: ${prompt_tokens}, resposta: ${completion_tokens}, total: ${total_tokens}`);
}

export async function analyzeJob(job: JobData): Promise<AnalysisResult> {
  const resumeText = loadResume();

  const userPrompt = [
    'CURRÍCULO:',
    resumeText,
    '',
    'VAGA:',
    `Título: ${job.title}`,
    `Empresa: ${job.company}`,
    `Descrição: ${truncateDescription(job.description)}`,
  ].join('\n');

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = 1000 * Math.pow(2, attempt);
      console.log(`   ⏳ Tentativa ${attempt + 1}/${MAX_RETRIES + 1} após ${delay / 1000}s...`);
      await sleep(delay);
    }

    try {
      const response = await openaiClient.chat.completions.create({
        model: 'gpt-4.1-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 512,
        response_format: { type: 'json_object' },
      });

      logTokenUsage(response.usage);

      const raw = response.choices[0]?.message?.content ?? '';
      const cleaned = stripMarkdownFences(raw);

      let parsed: any;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        console.error('Falha ao fazer JSON.parse da resposta do modelo:', raw);
        throw new Error('Resposta do modelo não é JSON válido.');
      }

      const { score, reason, keywords } = parsed ?? {};

      if (typeof score !== 'number' || score < 0 || score > 10) {
        throw new Error(`Campo "score" ausente ou inválido (esperado: 0-10, recebido: ${score}).`);
      }

      if (typeof reason !== 'string' || reason.length === 0) {
        throw new Error('Campo "reason" ausente ou inválido na resposta do modelo.');
      }

      if (
        !Array.isArray(keywords) ||
        keywords.length < MIN_KEYWORDS ||
        keywords.length > MAX_KEYWORDS ||
        !keywords.every((k: unknown) => typeof k === 'string')
      ) {
        throw new Error(
          `Campo "keywords" deve ser um array de ${MIN_KEYWORDS}-${MAX_KEYWORDS} strings (recebido: ${Array.isArray(keywords) ? keywords.length : typeof keywords}).`,
        );
      }

      return {
        score,
        relevant: score >= RELEVANCE_THRESHOLD,
        reason,
        keywords,
      };
    } catch (err: any) {
      lastError = err;

      const isRetryable =
        err?.status === 429 ||
        err?.status === 500 ||
        err?.status === 503 ||
        err?.code === 'ECONNRESET' ||
        err?.code === 'ETIMEDOUT';

      if (!isRetryable || attempt === MAX_RETRIES) {
        break;
      }
    }
  }

  throw lastError;
}

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
