import {
  getOrCreateSession,
  invalidateSession,
  LinkedInSession,
} from './linkedin-session';
import {
  searchGuestHttp,
  searchAuthenticatedHttp,
  searchAuthenticatedHtmlHttp,
} from './linkedin-api';

export const SEARCH_KEYWORDS = {
  frontend: {
    reactDeveloper: 'React Developer',
    frontendReactTs: 'Frontend React TypeScript',
    nextJsDeveloper: 'Next.js Developer',
    frontendEngineer: 'Frontend Engineer',
    /* angularDeveloper: 'Angular Developer', */
  },
  backend: {
    nodeJsDeveloper: 'Node.js Developer',
    backendEngineer: 'Backend Engineer',
    /* pythonDeveloper: 'Python Developer',
    javaDeveloper: 'Java Developer',
    golangDeveloper: 'Golang Developer', */
  },
  fullstack: {
    fullstackDeveloper: 'Fullstack Developer',
    fullstackEngineer: 'Fullstack Engineer',
    fullstackReactNode: 'Fullstack React Node',
    fullstackTypeScript: 'Fullstack TypeScript',
    fullstackJavaScript: 'Fullstack JavaScript',
  },
  webAnalytics: {
    gtm: 'Google Tag Manager',
    digitalAnalytics: 'Digital Analytics',
    webAnalyticsKeyword: 'Web Analytics',
    ga4Gtm: 'GA4 GTM',
    analyticsEngineer: 'Analytics Engineer',
  },
} as const;

export type SearchCategory = keyof typeof SEARCH_KEYWORDS;

function buildFlatKeywords(): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const category of Object.values(SEARCH_KEYWORDS)) {
    for (const [key, value] of Object.entries(category)) {
      flat[key] = value;
    }
  }
  return flat;
}

// Caching de FLAT_KEYWORDS
const FLAT_KEYWORDS = buildFlatKeywords();

export function resolveQuery(query: string): string {
  return FLAT_KEYWORDS[query] ?? query;
}

function getMaxSearchResults(): number {
  const envVal = process.env.MAX_SEARCH_RESULTS;
  if (envVal && !Number.isNaN(Number(envVal)) && Number(envVal) > 0) {
    return Math.floor(Number(envVal));
  }
  console.warn('MAX_SEARCH_RESULTS não configurado ou inválido. Usando valor padrão de 1000.');
  return 1000;
}

function buildSearchUrl(rawQuery: string, start = 0): string {
  const query = resolveQuery(rawQuery);
  const params = new URLSearchParams({
    keywords: query,
    location: 'Brazil',
    f_WT: '2',
    f_E: '2,3',
    start: String(start),
  });
  return `https://www.linkedin.com/jobs/search/?${params.toString()}`;
}

async function searchAuthenticated(session: LinkedInSession, query: string, maxResults: number): Promise<string[]> {
  if (session.voyagerQueryId) {
    const voyagerResult = await searchAuthenticatedHttp(session, query, maxResults);
    return voyagerResult;
  } else {
    const htmlResult = await searchAuthenticatedHtmlHttp(session, query, maxResults);
    return htmlResult;
  }
}

async function searchGuest(query: string, maxResults: number): Promise<string[]> {
  const guestIds = await searchGuestHttp(query, maxResults);
  return guestIds;
}

/**
 * Busca vagas no LinkedIn com arquitetura HTTP-first.
 *
 * Playwright é usado apenas para:
 *   1. Login (uma vez)
 *   2. Extração de tokens/QueryIDs/cookies
 *   3. Renovação de sessão quando expirar
 *
 * Todas as requisições de busca são feitas via HTTP (fetch):
 *   - Voyager API para busca autenticada (JSON, 25 vagas/página)
 *   - HTML auth fallback se Voyager não disponível
 *   - Guest API pública (HTML, 10 vagas/página)
 */
export async function searchJobs(query: string): Promise<string[]> {
  const resolvedQuery = resolveQuery(query);
  const maxResults = getMaxSearchResults();
  let mergedIds = new Set<string>();
  let page = 0;
  const limitPerPage = 25; // Número de resultados por página

  const session = await getOrCreateSession();

  if (session) {
    console.log('  🔍 Busca autenticada via HTTP...');

    try {
      while (mergedIds.size < maxResults) {
        const start = page * limitPerPage;
        const result = await searchAuthenticated(session, resolvedQuery, limitPerPage);

        for (const id of result.ids) mergedIds.add(id);
        console.log(`  📊 Página ${page + 1}: ${result.ids.length} vagas`);

        if (result.sessionExpired) {
          console.log('  🔄 Sessão expirada, invalidando para renovação futura...');
          invalidateSession();
          break;
        }

        page++;
      }
    } catch (err: any) {
      console.error(`  ⚠️  Erro na busca autenticada: ${err?.message ?? 'Erro desconhecido'}`);
      throw err; // Reta o erro para que possa ser capturado por chamadores externos, se necessário.
    }
  }

  console.log('  🔍 Complementando com busca guest (API pública HTTP)...');
  const guestIds = await searchGuest(resolvedQuery, maxResults);
  const guestNew = guestIds.filter((id) => !mergedIds.has(id));
  for (const id of guestIds) mergedIds.add(id);

  if (session) {
    console.log(`  📊 Guest: ${guestIds.length} vagas (+${guestNew.length} novas)`); // eslint-disable-line
  }

  const jobIds = Array.from(mergedIds);
  console.log(`  📄 Total: ${jobIds.length} vagas únicas encontradas.`);
  return jobIds.map((id) => `https://www.linkedin.com/jobs/view/${id}`);
}

if (require.main === module) {
  require('dotenv/config');
  const queryFromArgs = process.argv.slice(2).join(' ').trim();

  if (!queryFromArgs) {
    console.error('Uso: ts-node src/search.ts "<QUERY_DE_BUSCA>"');
    process.exit(1);
  }

  searchJobs(queryFromArgs)
    .then((urls) => {
      const searchUrl = buildSearchUrl(queryFromArgs);
      console.log(JSON.stringify(urls, null, 2));
      console.log(`Encontradas ${urls.length} vagas.`);
      console.log(`🔗 URL de busca do LinkedIn: ${searchUrl}`);
    })
    .catch((err) => {
      console.error('Erro ao buscar vagas:', err);
      process.exit(1);
    });
}