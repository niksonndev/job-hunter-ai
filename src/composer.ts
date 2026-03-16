import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import type { JobData } from './scraper';
import type { AnalysisResult } from './analyzer';

const OUTPUT_DIR = path.join(process.cwd(), 'data', 'outputs');

const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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

export async function composeEmail(job: JobData, analysis: AnalysisResult): Promise<string> {
  const systemPrompt = [
    'Você é um especialista em comunicação profissional para processos seletivos.',
    'Escreva emails de candidatura que pareçam humanos — diretos, confiantes, sem ser genéricos.',
    'Nunca use frases como "venho por meio deste", "gostaria de me candidatar" ou qualquer clichê corporativo.',
    'Retorne apenas o corpo do email, sem assunto, sem saudação genérica.',
  ].join('\n');

  const userPrompt = [
    'Escreva um email de candidatura para a vaga abaixo.',
    '',
    `VAGA: ${job.title}`,
    `EMPRESA: ${job.company}`,
    `KEYWORDS DA VAGA: ${analysis.keywords.join(', ')}`,
    `SCORE DE COMPATIBILIDADE: ${analysis.score}/10`,
    `MOTIVO: ${analysis.reason}`,
    '',
    'Use o tom de um desenvolvedor sênior confiante, não de alguém implorando por emprego.',
    'O email deve ter no máximo 4 parágrafos.',
    'Termine com uma chamada para ação clara.',
  ].join('\n');

  const response = await openaiClient.chat.completions.create({
    model: 'gpt-4.1-mini', // equivalente ao gpt-4o-mini
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.5,
  });

  const body = (response.choices[0]?.message?.content ?? '').trim();

  ensureOutputDir();

  const companySlug = sanitizeCompanyForFilename(job.company);
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const filename = `${companySlug}-${yyyy}-${mm}-${dd}-email.txt`;
  const outputPath = path.join(OUTPUT_DIR, filename);

  fs.writeFileSync(outputPath, body, 'utf8');

  return body;
}
