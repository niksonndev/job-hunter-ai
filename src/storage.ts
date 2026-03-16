import Database from 'better-sqlite3';
import path from 'path';
import type { JobData } from './scraper';
import type { AnalysisResult } from './analyzer';

const DB_PATH = path.join(process.cwd(), 'data', 'jobs.db');

export interface StoredJob {
  id: number;
  url: string;
  createdAt: string;
  title: string | null;
  company: string | null;
  reason: string | null;
  score: number | null;
  relevant: boolean | null;
  keywords: string[] | null;
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db
      .prepare(
        `
        CREATE TABLE IF NOT EXISTS jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url TEXT NOT NULL UNIQUE,
          title TEXT,
          company TEXT,
          reason TEXT,
          score INTEGER,
          relevant INTEGER,
          keywords TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `,
      )
      .run();
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

export function saveJobDetails(url: string, job: JobData, analysis: AnalysisResult): void {
  const database = getDb();
  const stmt = database.prepare(
    `
      UPDATE jobs
         SET title = ?,
             company = ?,
             reason = ?,
             score = ?,
             relevant = ?,
             keywords = ?
       WHERE url = ?
    `,
  );

  stmt.run(
    job.title,
    job.company,
    analysis.reason,
    analysis.score,
    analysis.relevant ? 1 : 0,
    JSON.stringify(analysis.keywords),
    url,
  );
}

