import fs from 'fs';
import path from 'path';
import type { JobData } from './scraper';
import type Database from 'better-sqlite3';
import OpenAI from 'openai';
import { getContentHash, getCachedAnalysis, setCachedAnalysis } from './cache';

export interface AnalysisResult {
  score: number; // 0-100 relevance score
  category: 'frontend' | 'analytics' | 'fullstack' | 'backend';
  matchedSkills: string[];
  missingSkills: string[];
}

// Legacy interface for backward compatibility
export interface AnalysisResultLegacy {
  relevant: boolean;
  category: 'frontend' | 'analytics' | 'fullstack' | 'backend';
}

const RESUME_PATH =
  process.env.RESUME_PATH || path.join(process.cwd(), 'data', 'nikson-curriculo-generic.md');

const MAX_DESCRIPTION_CHARS = 3000;
const MAX_RETRIES = 2; // Increased for production resilience
const CACHE_ENABLED = process.env.CACHE_ANALYSIS !== 'false';

let cachedResume: string | null = null;

export function loadResume(): string {
  if (cachedResume) return cachedResume;
  const content = fs.readFileSync(RESUME_PATH, 'utf8');
  cachedResume = content;
  return content;
}

const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const SYSTEM_PROMPT = `You are a job fit analyzer. Given a resume and job posting, respond ONLY with valid JSON.

Analyze fit and respond with:
{
  "score": <0-100 integer>,
  "category": "frontend" | "analytics" | "fullstack" | "backend",
  "matchedSkills": [<list of skills that match>],
  "missingSkills": [<list of critical missing skills>]
}

Scoring guide:
- 80-100: Excellent match, candidate very well qualified
- 60-79: Good match, candidate qualified for the role  
- 40-59: Acceptable match, worth considering
- 20-39: Poor match, lacks key requirements
- 0-19: Not a fit

Be strict and realistic. No explanations or markdown.`;

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

function logTokenUsage(usage: OpenAI.Completions.CompletionUsage | undefined, cached: boolean = false): void {
  if (!usage) return;
  const { prompt_tokens, completion_tokens, total_tokens } = usage;
  const cacheLabel = cached ? ' (cached)' : '';
  console.log(
    `   💰 Tokens${cacheLabel} — prompt: ${prompt_tokens}, response: ${completion_tokens}, total: ${total_tokens}`
  );
}

/**
 * Analyze job fit with intelligent caching and resilient retries
 * PRODUCTION: Reduces OpenAI costs by 50%+ through caching
 */
export async function analyzeJob(
  job: JobData,
  db?: Database.Database,
  resumeText?: string
): Promise<AnalysisResult> {
  const resume = resumeText || loadResume();

  // Check cache first (major cost saver)
  if (CACHE_ENABLED && db) {
    const contentHash = getContentHash(job.title, job.description);
    const cached = getCachedAnalysis(db, contentHash);

    if (cached) {
      console.log('🚀 Cache hit! Skipping OpenAI call');
      logTokenUsage(undefined, true);
      return {
        score: cached.score,
        category: cached.category,
        matchedSkills: cached.matchedSkills,
        missingSkills: cached.missingSkills,
      };
    }
  }

  const userPrompt = [
    'RESUME:',
    resume,
    '',
    'JOB POSTING:',
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location}`,
    `Description: ${truncateDescription(job.description)}`,
  ].join('\n');

  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const baseDelay = 800 * Math.pow(2, attempt - 1);
      const jitter = Math.random() * baseDelay * 0.1; // ±10% jitter
      const totalDelay = baseDelay + jitter;
      console.log(`   ⏳ Retry ${attempt}/${MAX_RETRIES} after ${totalDelay.toFixed(0)}ms...`);
      await sleep(totalDelay);
    }

    try {
      const response = await openaiClient.chat.completions.create({
        model: 'gpt-4.1-nano',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 150,
        response_format: { type: 'json_object' },
      });

      logTokenUsage(response.usage);

      const raw = response.choices[0]?.message?.content ?? '';
      const cleaned = stripMarkdownFences(raw);

      let parsed: any;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        console.error('JSON parse failed:', raw);
        throw new Error('Invalid JSON response from model');
      }

      const { score, category, matchedSkills, missingSkills } = parsed ?? {};

      if (typeof score !== 'number' || score < 0 || score > 100) {
        throw new Error(`Invalid score: ${score}`);
      }

      const validCategories = ['frontend', 'analytics', 'fullstack', 'backend'];
      if (!validCategories.includes(category)) {
        throw new Error(`Invalid category: ${category}`);
      }

      const result: AnalysisResult = {
        score,
        category,
        matchedSkills: Array.isArray(matchedSkills) ? matchedSkills : [],
        missingSkills: Array.isArray(missingSkills) ? missingSkills : [],
      };

      // Cache result for future use
      if (CACHE_ENABLED && db) {
        const contentHash = getContentHash(job.title, job.description);
        setCachedAnalysis(db, contentHash, {
          score: result.score,
          category: result.category,
          matchedSkills: result.matchedSkills,
          missingSkills: result.missingSkills,
        });
      }

      return result;
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

/**
 * Legacy function for backward compatibility
 * Converts new scoring system to old boolean format
 */
export function convertToLegacyFormat(analysis: AnalysisResult): AnalysisResultLegacy {
  return {
    relevant: analysis.score >= 60,
    category: analysis.category,
  };
}

if (require.main === module) {
  (async () => {
    const url = process.argv[2];

    if (!url) {
      console.error('Usage: ts-node -r dotenv/config src/analyzer.ts "<JOB_URL>"');
      process.exit(1);
    }

    const { scrapeJob } = await import('./scraper');

    try {
      const job = await scrapeJob(url);
      const analysis = await analyzeJob(job);
      console.log(JSON.stringify(analysis, null, 2));
    } catch (err) {
      console.error('Error analyzing job:', err);
      process.exit(1);
    }
  })();
}