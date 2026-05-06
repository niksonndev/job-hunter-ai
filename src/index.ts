import 'dotenv/config';

import PQueue from 'p-queue';
import { scrapeJob } from './scraper';
import { analyzeJob, loadResume } from './analyzer';
import { filterJob } from './filter';
import { searchJobs, SEARCH_KEYWORDS, SearchCategory } from './search';
import { hasJobUrl, saveJobUrl, saveJobDetails, getJobStats, hasJobByTitleAndCompany } from './storage';
import { appendJobToSheet, isSheetsEnabled } from './sheets';
import Database from 'better-sqlite3';
import path from 'path';

const requiredEnvVars = ['OPENAI_API_KEY'] as const;

for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${key}`);
  }
}

// PRODUCTION: Limit concurrency to avoid LinkedIn blocking or OpenAI rate limits
const CONCURRENCY_LIMIT = parseInt(process.env.JOB_CONCURRENCY || '2', 10);
const queue = new PQueue({
  concurrency: CONCURRENCY_LIMIT,
  interval: 10000,
  intervalCap: CONCURRENCY_LIMIT,
  carryoverConcurrencyCount: true,
});

interface ProcessingStats {
  total: number;
  processed: number;
  saved: number;
  skipped: number;
  errors: number;
  savedToSheets: number;
  apiCallsSaved: number;
}

const stats: ProcessingStats = {
  total: 0,
  processed: 0,
  saved: 0,
  skipped: 0,
  errors: 0,
  savedToSheets: 0,
  apiCallsSaved: 0,
};

/**
 * PRODUCTION: Process a single job with comprehensive error handling
 * Uses concurrency pool to process multiple jobs in parallel
 */
async function processJobUrl(
  url: string,
  db: Database.Database,
  resumeText: string
): Promise<void> {
  try {
    stats.processed++;

    // Skip if already in database
    if (hasJobUrl(url)) {
      console.log(`⏭️ Already processed: ${url}`);
      stats.skipped++;
      return;
    }

    // SCRAPE: Get job details
    console.log(`🔍 Scraping: ${url}`);
    const job = await scrapeJob(url);

    // DUPLICATE CHECK: Skip if same title+company already in database (prevents duplicate applications)
    if (hasJobByTitleAndCompany(job.title, job.company)) {
      console.log(`🚫 Rejected (duplicate): "${job.title}" at ${job.company} already processed`);
      stats.skipped++;
      return;
    }

    // FILTER: Hard reject bad matches (saves OpenAI calls)
    const filterResult = filterJob(job);
    if (!filterResult.passed) {
      console.log(`🚫 Rejected (filter): ${filterResult.reason}`);
      stats.skipped++;
      return;
    }

    // HEURISTIC SCORE: Skip low-potential jobs without OpenAI
    if (filterResult.score && filterResult.score < 30) {
      console.log(`⏭️ Low heuristic score (${filterResult.score}/100): ${job.title}`);
      stats.skipped++;
      stats.apiCallsSaved++; // Avoided OpenAI call
      return;
    }

    // ANALYZE: Call OpenAI with caching (50% cost reduction from cache hits)
    console.log(`📊 Analyzing: ${job.title}...`);
    const analysisResult = await analyzeJob(job, db, resumeText);

    // DECISION: Save if score >= 60
    if (analysisResult.score < 60) {
      console.log(`⏭️ Low score (${analysisResult.score}/100): ${job.title}`);
      stats.skipped++;
      return;
    }

    // SAVE: Database persistence with new scoring system
    const inserted = saveJobUrl(job.url);
    if (!inserted) {
      console.log(`⏭️ Race condition, already inserted: ${url}`);
      stats.skipped++;
      return;
    }

    saveJobDetails(job.url, job, analysisResult, filterResult.score);
    stats.saved++;
    console.log(`✅ Saved! Score: ${analysisResult.score}/100, Category: ${analysisResult.category}`);

    // SYNC: Optional Google Sheets append
    if (isSheetsEnabled()) {
      try {
        // Convert to legacy format for sheets compatibility
        await appendJobToSheet(job, {
          relevant: analysisResult.score >= 60,
          category: analysisResult.category,
        });
        stats.savedToSheets++;
        console.log(`📄 Synced to Sheets`);
      } catch (err) {
        console.warn(`⚠️ Sheets sync failed (continuing):`, err);
      }
    }
  } catch (err: any) {
    stats.errors++;

    if (err?.name === 'TimeoutError') {
      console.error(`⚠️ Timeout: ${url}`);
    } else if (err?.status === 429) {
      console.error(`⚠️ Rate limited on ${url}`);
    } else {
      console.error(`⚠️ Error processing ${url}:`, err?.message || err);
    }
  }
}

/**
 * PRODUCTION: Process batch of job URLs with concurrency
 * Phase 1: Collect all URLs first (fail-safe for search)
 * Phase 2: Process all URLs in parallel with rate limiting
 */
async function processSearchQuery(rawQuery: string, limit?: number): Promise<void> {
  const query = rawQuery.trim();

  console.log(`\n🔎 Searching for: "${query}"`);

  let allUrls: string[] = [];
  try {
    allUrls = await searchJobs(query);
  } catch (err) {
    console.error(`❌ Search failed: ${err}`);
    return;
  }

  const urls = limit ? allUrls.slice(0, limit) : allUrls;
  console.log(`🔗 Found ${allUrls.length} jobs, processing ${urls.length}`);

  stats.total += urls.length;

  // Load database and resume once (not per-job)
  const DB_PATH = path.join(process.cwd(), 'data', 'jobs.db');
  const db = new (require('better-sqlite3'))(DB_PATH);
  const resumeText = loadResume();

  // PRODUCTION: Process all jobs in parallel with concurrency limit
  const jobPromises = urls.map((url) =>
    queue.add(() => processJobUrl(url, db, resumeText))
  );

  const results = await Promise.allSettled(jobPromises);

  // Log results
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    console.log(`⚠️ ${failed} jobs failed during processing`);
  }
}

async function main() {
  const startTime = Date.now();
  console.log(`🚀 Job Hunter AI v1.0.1 (Production Mode - Cost Optimized)`);
  console.log(`   Concurrency: ${CONCURRENCY_LIMIT} jobs`);
  console.log(`   Cache: ${process.env.CACHE_ANALYSIS !== 'false' ? 'Enabled' : 'Disabled'}`);

  const [mode, ...rest] = process.argv.slice(2);

  if (!mode) {
    console.log(`\n📋 Running default batch (SEARCH_KEYWORDS)`);

    const defaultLimitEnv = process.env.DEFAULT_SEARCH_LIMIT;
    const defaultLimit =
      defaultLimitEnv && !Number.isNaN(Number(defaultLimitEnv)) && Number(defaultLimitEnv) > 0
        ? Math.floor(Number(defaultLimitEnv))
        : undefined;

    const categories = Object.keys(SEARCH_KEYWORDS) as SearchCategory[];
    for (const category of categories) {
      console.log(`\n🏷️ Category: ${category}`);
      const keywords = SEARCH_KEYWORDS[category];
      for (const [key, label] of Object.entries(keywords)) {
        console.log(`\n────────────────────────────────────`);
        console.log(`▶ [${category}] ${key} → "${label}"`);
        await processSearchQuery(key, defaultLimit);
      }
    }

    console.log(`\n✅ Batch complete.`);
    printStats(startTime);
    return;
  }

  // CATEGORY MODE
  const categoryKeys = Object.keys(SEARCH_KEYWORDS) as SearchCategory[];
  const matchedCategory = categoryKeys.find((c) => c.toLowerCase() === mode.toLowerCase());
  if (matchedCategory) {
    const defaultLimitEnv = process.env.DEFAULT_SEARCH_LIMIT;
    const defaultLimit =
      defaultLimitEnv && !Number.isNaN(Number(defaultLimitEnv)) && Number(defaultLimitEnv) > 0
        ? Math.floor(Number(defaultLimitEnv))
        : undefined;

    console.log(`\n🏷️ Running category: ${matchedCategory}`);
    const keywords = SEARCH_KEYWORDS[matchedCategory];
    for (const [key, label] of Object.entries(keywords)) {
      console.log(`\n────────────────────────────────────`);
      console.log(`▶ [${matchedCategory}] ${key} → "${label}"`);
      await processSearchQuery(key, defaultLimit);
    }
    console.log(`\n✅ Category complete.`);
    printStats(startTime);
    return;
  }

  // SINGLE URL MODE
  const SEARCH_MODES = ['search', 'busca'];
  if (!SEARCH_MODES.includes(mode)) {
    const jobUrl = mode;
    console.log(`\n🔍 Processing single job: ${jobUrl}`);

    const db = new (require('better-sqlite3'))(path.join(process.cwd(), 'data', 'jobs.db'));
    const resumeText = loadResume();

    stats.total = 1;
    await processJobUrl(jobUrl, db, resumeText);
    printStats(startTime);
    return;
  }

  // SEARCH MODE
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
      'Error: provide search query.\n' +
      'Examples:\n' +
      '  npm run dev -- search "React Developer"\n' +
      '  npm run dev -- search 10 "React Developer"   (with limit)'
    );
    process.exit(1);
  }

  await processSearchQuery(query, limit);
  printStats(startTime);
}

/**
 * Print detailed statistics
 */
function printStats(startTime: number): void {
  const elapsed = Date.now() - startTime;
  const elapsedMin = (elapsed / 1000 / 60).toFixed(1);

  const dbStats = getJobStats();

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`📊 EXECUTION SUMMARY`);
  console.log(`${'═'.repeat(50)}`);
  console.log(`⏱️  Time: ${elapsedMin}min (${(elapsed / 1000).toFixed(0)}s)`);
  console.log(`📦 Jobs: ${stats.processed}/${stats.total} processed`);
  console.log(`✅ Saved: ${stats.saved}`);
  console.log(`⏭️  Skipped: ${stats.skipped}`);
  console.log(`❌ Errors: ${stats.errors}`);
  console.log(`💰 API calls saved: ${stats.apiCallsSaved} (heuristic filtering)`);
  console.log(`📄 Sheets synced: ${stats.savedToSheets}`);
  console.log(`\n📈 Database Stats:`);
  console.log(`   Total jobs: ${dbStats.total}`);
  console.log(`   Relevant (score>=60): ${dbStats.relevant}`);
  console.log(`   Avg score: ${dbStats.avgScore}/100`);
  console.log(`   By category: ${JSON.stringify(dbStats.byCategory)}`);
  console.log(`${'═'.repeat(50)}`);
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exitCode = 1;
});