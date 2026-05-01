import Database from 'better-sqlite3';
import path from 'path';
import type { JobData } from './scraper';
import type { AnalysisResult } from './analyzer';
import { initializeAnalysisCache } from './cache';

const DB_PATH = path.join(process.cwd(), 'data', 'jobs.db');

export interface StoredJob {
  id: number;
  url: string;
  createdAt: string;
  title: string | null;
  company: string | null;
  score: number | null; // 0-100 relevance score
  category: string | null;
  matchedSkills: string[];
  missingSkills: string[];
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);

    // PERFORMANCE: Enable WAL mode and optimizations
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL'); // Balance safety & speed
    db.pragma('cache_size = 5000'); // More cache
    db.pragma('temp_store = MEMORY'); // Temp tables in RAM

    // Main jobs table (PRODUCTION: Must support new scoring system)
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL UNIQUE,
        title TEXT,
        company TEXT,
        score INTEGER,
        category TEXT,
        matched_skills TEXT DEFAULT '[]',
        missing_skills TEXT DEFAULT '[]',
        heuristic_score REAL DEFAULT 50,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Migration: Add new columns if they don't exist (legacy DB support)
    const columns = db
      .prepare('PRAGMA table_info(jobs)')
      .all() as Array<{ name: string }>;

    const columnsToAdd: Record<string, string> = {
      score: 'INTEGER',
      matched_skills: "TEXT DEFAULT '[]'",
      missing_skills: "TEXT DEFAULT '[]'",
      heuristic_score: 'REAL DEFAULT 50',
    };

    for (const [colName, colDef] of Object.entries(columnsToAdd)) {
      if (!columns.some((c) => c.name === colName)) {
        db.prepare(`ALTER TABLE jobs ADD COLUMN ${colName} ${colDef}`).run();
      }
    }

    // PERFORMANCE: Create indexes for common queries (huge speedup for large datasets)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_url ON jobs(url);
      CREATE INDEX IF NOT EXISTS idx_score ON jobs(score DESC);
      CREATE INDEX IF NOT EXISTS idx_category ON jobs(category);
      CREATE INDEX IF NOT EXISTS idx_created_at ON jobs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_heuristic_score ON jobs(heuristic_score DESC);
    `);

    // Initialize analysis cache table
    initializeAnalysisCache(db);
  }
  return db;
}

export function saveJobUrl(url: string): boolean {
  const database = getDb();
  try {
    const stmt = database.prepare('INSERT INTO jobs (url) VALUES (?)');
    stmt.run(url);
    return true;
  } catch (err: any) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return false;
    }
    throw err;
  }
}

export function hasJobUrl(url: string): boolean {
  const database = getDb();
  const row = database.prepare('SELECT 1 FROM jobs WHERE url = ? LIMIT 1').get(url);
  return !!row;
}

/**
 * Save job details with new scoring system
 * PRODUCTION: Supports both old (relevant: boolean) and new (score: 0-100) formats
 */
export function saveJobDetails(
  url: string,
  job: JobData,
  analysis: AnalysisResult,
  heuristicScore?: number
): void {
  const database = getDb();

  const stmt = database.prepare(`
    UPDATE jobs
    SET title = ?,
        company = ?,
        score = ?,
        category = ?,
        matched_skills = ?,
        missing_skills = ?,
        heuristic_score = ?
    WHERE url = ?
  `);

  stmt.run(
    job.title,
    job.company,
    analysis.score,
    analysis.category,
    JSON.stringify(analysis.matchedSkills || []),
    JSON.stringify(analysis.missingSkills || []),
    heuristicScore ?? 50,
    url
  );
}

/**
 * Get job by URL (for queries)
 */
export function getJobByUrl(url: string): StoredJob | null {
  const database = getDb();
  const row = database.prepare('SELECT * FROM jobs WHERE url = ? LIMIT 1').get(url) as any;

  if (!row) return null;

  return {
    id: row.id,
    url: row.url,
    createdAt: row.created_at,
    title: row.title,
    company: row.company,
    score: row.score,
    category: row.category,
    matchedSkills: row.matched_skills ? JSON.parse(row.matched_skills) : [],
    missingSkills: row.missing_skills ? JSON.parse(row.missing_skills) : [],
  };
}

/**
 * Get all relevant jobs sorted by score (for reporting/ranking)
 */
export function getRelevantJobs(minScore: number = 60, limit: number = 100): StoredJob[] {
  const database = getDb();
  const rows = database
    .prepare(`
      SELECT * FROM jobs
      WHERE score >= ?
      ORDER BY score DESC, created_at DESC
      LIMIT ?
    `)
    .all(minScore, limit) as any[];

  return rows.map((row) => ({
    id: row.id,
    url: row.url,
    createdAt: row.created_at,
    title: row.title,
    company: row.company,
    score: row.score,
    category: row.category,
    matchedSkills: row.matched_skills ? JSON.parse(row.matched_skills) : [],
    missingSkills: row.missing_skills ? JSON.parse(row.missing_skills) : [],
  }));
}

/**
 * Get statistics for current run
 */
export function getJobStats(): {
  total: number;
  relevant: number;
  avgScore: number;
  byCategory: Record<string, number>;
} {
  const database = getDb();

  const total = (database.prepare('SELECT COUNT(*) as count FROM jobs').get() as any)?.count || 0;
  const relevant = (database.prepare('SELECT COUNT(*) as count FROM jobs WHERE score >= 60').get() as any)
    ?.count || 0;
  const avgScore = (database.prepare('SELECT AVG(score) as avg FROM jobs WHERE score > 0').get() as any)
    ?.avg || 0;

  const byCat = database
    .prepare(`
      SELECT category, COUNT(*) as count FROM jobs 
      WHERE category IS NOT NULL 
      GROUP BY category
    `)
    .all() as any[];

  const byCategory: Record<string, number> = {};
  for (const row of byCat) {
    byCategory[row.category] = row.count;
  }

  return {
    total,
    relevant,
    avgScore: Math.round(avgScore),
    byCategory,
  };
}

/**
 * Get top companies by job count
 */
export function getTopCompanies(limit: number = 10): Array<{ company: string; count: number; avgScore: number }> {
  const database = getDb();
  const rows = database
    .prepare(`
      SELECT company, COUNT(*) as count, ROUND(AVG(score), 0) as avgScore
      FROM jobs 
      WHERE company IS NOT NULL AND score > 0
      GROUP BY company
      ORDER BY count DESC
      LIMIT ?
    `)
    .all(limit) as any[];

  return rows.map((row) => ({
    company: row.company,
    count: row.count,
    avgScore: row.avgScore || 0,
  }));
}


