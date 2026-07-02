import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import type { JobData } from './scraper';
import type { AnalysisResult } from './analyzer';

const RESUME_PATH = path.join(process.cwd(), 'data', 'nikson-resume-master-en.md');
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

  // Validate job description exists
  if (!job.description || job.description.trim().length === 0) {
    throw new Error('Job description is empty or missing. Cannot adapt resume without job details.');
  }

  const systemPrompt = [
    'You are an expert technical recruiter and ATS resume specialist.',
    'Task: adapt the candidate\'s master resume to match a specific job posting.',
    '',
    'Mandatory rules:',
    '- Never invent experience, skills, or achievements not present in the master resume. Only reorder, re-prioritize, and rephrase existing content.',
    '- Reorder and emphasize skills/bullet points to mirror the job posting\'s key requirements and terminology.',
    '- Naturally incorporate relevant technical keywords from the job posting, but only where truthfully applicable.',
    '- Avoid empty adjectives ("hard-working", "passionate", "team player") unless backed by a concrete example already in the master resume.',
    '- Keep total length equivalent to one page (approximately 450-550 words in the body, excluding headers).',
    '- Match the output language to the job posting\'s language.',
    '- Preserve markdown formatting from the master resume structure.',
    '- Output ONLY the rewritten resume in markdown. No explanations, no preamble, no comments.',
  ].join('\n');

  const userPrompt = [
    `JOB TITLE: ${job.title}`,
    `COMPANY: ${job.company}`,
    `CATEGORY: ${analysis.category}`,
    `MATCHED SKILLS: ${analysis.matchedSkills.join(', ') || 'N/A'}`,
    `MISSING SKILLS: ${analysis.missingSkills.join(', ') || 'N/A'}`,
    `JOB DESCRIPTION: ${job.description}`,
    'ORIGINAL RESUME:',
    originalResume,
  ].join('\n');

  const response = await openaiClient.chat.completions.create({
    model: 'gpt-4.1-mini', // usa gpt-4o equivalente (ajuste aqui se quiser o nome exato do modelo)
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
