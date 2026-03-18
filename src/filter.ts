import type { JobData } from './scraper';

export interface FilterResult {
  passed: boolean;
  reason?: string;
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
];

const EXCLUDED_TECHNOLOGIES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Java', pattern: /\bjava\b(?!script)/ },
  { label: '.NET', pattern: /\.net\b/ },
  { label: 'C#', pattern: /\bc#/ },
  { label: 'PHP', pattern: /\bphp\b/ },
  { label: 'Ruby', pattern: /\bruby\b/ },
  { label: 'Rails', pattern: /\brails\b/ },
  { label: 'Golang', pattern: /\bgolang\b/ },
  { label: 'Go', pattern: /\bgo\s+(developer|engineer|dev|eng)\b/ },
];

const EXCLUDED_COMPANIES: string[] = [];

function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function filterJob(job: JobData): FilterResult {
  const title = normalize(job.title);
  const company = normalize(job.company);

  const isIntern = INTERN_TERMS.some((term) => title.includes(normalize(term)));
  if (isIntern) {
    return { passed: false, reason: `Nível estágio/trainee detectado no título: "${job.title}"` };
  }

  const excludedTech = EXCLUDED_TECHNOLOGIES.find((t) => t.pattern.test(title));
  if (excludedTech) {
    return { passed: false, reason: `Tecnologia excluída detectada no título: "${excludedTech.label}"` };
  }

  const excludedCompany = EXCLUDED_COMPANIES.find((c) => company.includes(normalize(c)));
  if (excludedCompany) {
    return { passed: false, reason: `Empresa excluída: "${job.company}"` };
  }

  return { passed: true };
}
