import crypto from 'crypto';
import Database from 'better-sqlite3';

export interface CachedAnalysis {
  contentHash: string;
  score: number;
  category: 'frontend' | 'analytics' | 'fullstack' | 'backend';
  matchedSkills: string[];
  missingSkills: string[];
  timestamp: number;
}

// 7 days TTL
const CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

let memoryCache: Map<string, CachedAnalysis> = new Map();

export function initializeAnalysisCache(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS analysis_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_hash TEXT UNIQUE NOT NULL,
      score INTEGER NOT NULL,
      category TEXT NOT NULL,
      matched_skills TEXT NOT NULL DEFAULT '[]',
      missing_skills TEXT NOT NULL DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_content_hash ON analysis_cache(content_hash);
  `);
}

/**
 * Generate content hash from job title and description
 * Used to detect duplicate/similar job postings
 */
export function getContentHash(title: string, description: string): string {
  const combined = `${title.toLowerCase()}|||${description.toLowerCase()}`;
  return crypto.createHash('md5').update(combined).digest('hex');
}

/**
 * Check if analysis result is cached in memory or database
 */
export function getCachedAnalysis(
  db: Database.Database,
  contentHash: string
): CachedAnalysis | null {
  // Check memory first (fast)
  const memCached = memoryCache.get(contentHash);
  if (memCached && Date.now() - memCached.timestamp < CACHE_TTL) {
    return memCached;
  }

  // Check database
  const dbCached = db
    .prepare('SELECT * FROM analysis_cache WHERE content_hash = ? LIMIT 1')
    .get(contentHash) as any;

  if (dbCached) {
    const timestamp = new Date(dbCached.created_at).getTime();
    if (Date.now() - timestamp < CACHE_TTL) {
      const result: CachedAnalysis = {
        contentHash: dbCached.content_hash,
        score: dbCached.score,
        category: dbCached.category,
        matchedSkills: JSON.parse(dbCached.matched_skills || '[]'),
        missingSkills: JSON.parse(dbCached.missing_skills || '[]'),
        timestamp,
      };

      // Promote to memory cache for next access
      memoryCache.set(contentHash, result);
      return result;
    }
  }

  return null;
}

/**
 * Store analysis result in both memory and database
 */
export function setCachedAnalysis(
  db: Database.Database,
  contentHash: string,
  analysis: Omit<CachedAnalysis, 'timestamp' | 'contentHash'>
): void {
  db.prepare(`
    INSERT INTO analysis_cache (content_hash, score, category, matched_skills, missing_skills)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(content_hash) DO UPDATE SET
      score = excluded.score,
      category = excluded.category,
      matched_skills = excluded.matched_skills,
      missing_skills = excluded.missing_skills
  `).run(
    contentHash,
    analysis.score,
    analysis.category,
    JSON.stringify(analysis.matchedSkills),
    JSON.stringify(analysis.missingSkills)
  );

  const cached: CachedAnalysis = {
    contentHash,
    timestamp: Date.now(),
    ...analysis,
  };

  memoryCache.set(contentHash, cached);
}

/**
 * Get cache statistics (for monitoring)
 */
export function getCacheStats(db: Database.Database): { total: number; avgScore: number } {
  const stats = db
    .prepare('SELECT COUNT(*) as total, AVG(score) as avgScore FROM analysis_cache')
    .get() as any;

  return {
    total: stats.total || 0,
    avgScore: Math.round(stats.avgScore || 0),
  };
}

/**
 * Clear old cache entries
 */
export function cleanupExpiredCache(db: Database.Database): number {
  const result = db
    .prepare(
      `DELETE FROM analysis_cache WHERE 
       datetime(created_at) < datetime('now', '-7 days')`
    )
    .run();

  memoryCache.clear(); // Also clear memory cache

  return result.changes;
}
