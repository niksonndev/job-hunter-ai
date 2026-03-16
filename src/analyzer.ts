import type { JobData } from './scraper';

export interface AnalysisResult {
  isRelevant: boolean;
  score: number;
  reasons: string[];
}

export function analyzeJob(job: JobData, resumeText: string): AnalysisResult {
  return {
    isRelevant: false,
    score: 0,
    reasons: [],
  };
}
