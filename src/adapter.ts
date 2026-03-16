import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import type { JobData } from './scraper';
import type { AnalysisResult } from './analyzer';

const RESUME_PATH = path.join(process.cwd(), 'data', 'nikson-curriculo-pt.md');
const OUTPUT_DIR = path.join(process.cwd(), 'data', 'outputs');

const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function loadResume(): string {
  return fs.readFileSync(RESUME_PATH, 'utf8');
}

function ensureOutputDir() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

function sanitizeCompanyForFilename(company: string): string {
  return company
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'empresa';
}

export async function adaptResume(job: JobData, analysis: AnalysisResult): Promise<string> {
  const originalResume = loadResume();

  const systemPrompt = [
    'Você é um especialista em currículos otimizados para ATS (Applicant Tracking Systems).',
    'Sua tarefa é reescrever o currículo fornecido para maximizar a compatibilidade com a vaga.',
    'Regras obrigatórias:',
    '- Mantenha 100% das informações verdadeiras — nunca invente experiências ou habilidades',
    '- Incorpore naturalmente as keywords fornecidas onde forem verdadeiras',
    '- Priorize e reordene as seções de skills para refletir os requisitos da vaga',
    '- Mantenha o formato markdown',
    '- Retorne apenas o currículo reescrito, sem explicações adicionais',
  ].join('\n');

  const userPrompt = [
    `KEYWORDS DA VAGA: ${analysis.keywords.join(', ')}`,
    `TÍTULO DA VAGA: ${job.title}`,
    `EMPRESA: ${job.company}`,
    '',
    'CURRÍCULO ORIGINAL:',
    originalResume,
  ].join('\n');

  const response = await openaiClient.chat.completions.create({
    model: 'gpt-4.1', // usa gpt-4o equivalente (ajuste aqui se quiser o nome exato do modelo)
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
  });

  const adapted = response.choices[0]?.message?.content ?? '';

  // Garante que vem texto "puro" (sem null/undefined).
  const finalResume = adapted.trim();

  ensureOutputDir();

  const companySlug = sanitizeCompanyForFilename(job.company);
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const filename = `${companySlug}-${yyyy}-${mm}-${dd}-resume.md`;
  const outputPath = path.join(OUTPUT_DIR, filename);

  fs.writeFileSync(outputPath, finalResume, 'utf8');

  return finalResume;
}
