import type { JobData } from './scraper';

export interface FilterResult {
  passed: boolean;
  reason?: string;
  score?: number; // 0-100 heuristic score (higher = send to OpenAI for detailed analysis)
}

const INTERN_TERMS = [
  'estágio',
  'estagio',
  'estagiário',
  'estagiario',
  'trainee',
  'apprentice',
  'intern',
  'júnior estágio',
  'junior estágio',
];

const HARD_REJECT_TECHNOLOGIES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Java', pattern: /\bjava\b(?!script)/ },
  { label: '.NET', pattern: /\.net\b/ },
  { label: 'C#', pattern: /\bc#/ },
  { label: 'PHP', pattern: /\bphp\b/ },
  { label: 'Ruby', pattern: /\bruby\b/ },
  { label: 'Rails', pattern: /\brails\b/ },
  { label: 'Golang', pattern: /\bgolang\b/ },
  { label: 'Go', pattern: /\bgo\s+(developer|engineer|dev|eng)\b/ },
];

const HARD_REJECT_PATTERNS = [
  { label: 'Freelance', pattern: /\b(freelance|freelancer|contractor|1099)\b/ },
  { label: 'Contract-only', pattern: /\b(contract\s+to\s+hire|c2h|short[\s-]?term)\b/ },
];

// Keywords that boost heuristic score (indicate strong fit)
const BOOST_KEYWORDS: Record<string, number> = {
  'typescript': 1.25,
  'react': 1.20,
  'node': 1.15,
  'node.js': 1.15,
  'nodejs': 1.15,
  'aws': 1.10,
  'graphql': 1.15,
  'postgres': 1.10,
  'sql': 1.08,
  'api': 1.05,
  'rest': 1.05,
  'javascript': 1.03,
  'js': 1.03,
};

// Keywords that reduce heuristic score
const REDUCE_KEYWORDS: Record<string, number> = {
  'legacy': 0.8,
  'deprecated': 0.7,
  'old': 0.85,
  'maintenance': 0.85,
};

const EXCLUDED_COMPANIES: string[] = [];
const MIN_SCORE_FOR_ANALYSIS = 30; // Skip OpenAI if score < this

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Simple heuristic-based filter to avoid sending obvious rejects to OpenAI
 * Saves ~40-60% on API costs by pre-filtering before expensive analysis
 * 
 * Returns:
 * - passed: false (hard reject) → skip entirely
 * - passed: true, score < 30 → low potential, skip OpenAI but might log
 * - passed: true, score >= 30 → good candidate, send to OpenAI for detailed analysis
 */
export function filterJob(job: JobData): FilterResult {
  const combined = normalize(`${job.title} ${job.description}`);
  const title = normalize(job.title);
  const company = normalize(job.company);

  // HARD REJECTS (skip entirely, don't send to OpenAI)
  const isIntern = INTERN_TERMS.some((term) => combined.includes(normalize(term)));
  if (isIntern) {
    return {
      passed: false,
      reason: `Hard reject: Internship/trainee level detected`,
    };
  }

  const excludedTech = HARD_REJECT_TECHNOLOGIES.find((t) => t.pattern.test(combined));
  if (excludedTech) {
    return {
      passed: false,
      reason: `Hard reject: Excluded technology "${excludedTech.label}"`,
    };
  }

  const hardRejectPattern = HARD_REJECT_PATTERNS.find((t) => t.pattern.test(combined));
  if (hardRejectPattern) {
    return {
      passed: false,
      reason: `Hard reject: ${hardRejectPattern.label}`,
    };
  }

  const excludedCompany = EXCLUDED_COMPANIES.find((c) => company.includes(normalize(c)));
  if (excludedCompany) {
    return {
      passed: false,
      reason: `Hard reject: Excluded company`,
    };
  }

  // SCORING (0-100 heuristic score for jobs that pass hard filters)
  let score = 50; // Baseline neutral score

  // Boost for presence of desired keywords
  for (const [keyword, multiplier] of Object.entries(BOOST_KEYWORDS)) {
    if (combined.includes(keyword)) {
      score *= multiplier;
    }
  }

  // Reduce for presence of undesirable keywords
  for (const [keyword, multiplier] of Object.entries(REDUCE_KEYWORDS)) {
    if (combined.includes(keyword)) {
      score *= multiplier;
    }
  }

  // Clamp to 0-100
  score = Math.max(0, Math.min(100, score));

  return {
    passed: true,
    score,
  };
}

/**
 * Legacy function for backward compatibility
 */
export function filterJobLegacy(job: JobData): FilterResult {
  const result = filterJob(job);
  // In legacy mode, only return true/false based on hard filters
  return {
    passed: result.passed,
    reason: result.reason,
  };
}
