import { Page } from 'playwright';

const CAPSOLVER_API = 'https://api.capsolver.com';
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_ATTEMPTS = 40; // ~120 seconds

function getApiKey(): string | null {
  return process.env.CAPSOLVER_API_KEY?.trim() || null;
}

interface CreateTaskResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: string;
}

interface GetTaskResultResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  status?: 'idle' | 'processing' | 'ready';
  solution?: {
    gRecaptchaResponse?: string;
    token?: string;
  };
}

async function apiRequest<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${CAPSOLVER_API}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`CapSolver API error: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

/**
 * Extrai o site key do reCAPTCHA da página.
 * Procura em data-sitekey, iframes do reCAPTCHA e scripts inline.
 */
export async function extractRecaptchaSiteKey(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    // data-sitekey attribute
    const el = document.querySelector('[data-sitekey]');
    if (el) return el.getAttribute('data-sitekey');

    // reCAPTCHA iframe src
    const iframe = document.querySelector('iframe[src*="recaptcha"]') as HTMLIFrameElement | null;
    if (iframe?.src) {
      const match = iframe.src.match(/[?&]k=([^&]+)/);
      if (match) return match[1];
    }

    // Script tag with render parameter
    const scripts = document.querySelectorAll('script[src*="recaptcha"]');
    for (const s of scripts) {
      const src = (s as HTMLScriptElement).src;
      const match = src.match(/[?&]render=([^&]+)/);
      if (match && match[1] !== 'explicit') return match[1];
    }

    return null;
  });
}

/**
 * Resolve reCAPTCHA v2 usando a API do CapSolver.
 * Retorna o token gRecaptchaResponse ou null se falhar.
 */
export async function solveRecaptchaV2(websiteURL: string, websiteKey: string): Promise<string | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.log('    ⚠️  CAPSOLVER_API_KEY não configurada, não é possível resolver CAPTCHA.');
    return null;
  }

  console.log('    🧩 Enviando CAPTCHA para CapSolver...');

  const createRes = await apiRequest<CreateTaskResponse>('/createTask', {
    clientKey: apiKey,
    task: {
      type: 'ReCaptchaV2TaskProxyLess',
      websiteURL,
      websiteKey,
    },
  });

  if (createRes.errorId !== 0 || !createRes.taskId) {
    console.log(`    ❌ Erro ao criar task: ${createRes.errorCode} — ${createRes.errorDescription}`);
    return null;
  }

  console.log(`    ⏳ Task criada (${createRes.taskId}), aguardando resolução...`);

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const result = await apiRequest<GetTaskResultResponse>('/getTaskResult', {
      clientKey: apiKey,
      taskId: createRes.taskId,
    });

    if (result.errorId !== 0) {
      console.log(`    ❌ Erro ao consultar resultado: ${result.errorCode}`);
      return null;
    }

    if (result.status === 'ready' && result.solution?.gRecaptchaResponse) {
      console.log('    ✅ CAPTCHA resolvido pelo CapSolver!');
      return result.solution.gRecaptchaResponse;
    }
  }

  console.log('    ❌ Timeout aguardando resolução do CapSolver.');
  return null;
}

/**
 * Injeta o token de solução do reCAPTCHA na página e submete.
 */
export async function injectRecaptchaToken(page: Page, token: string): Promise<void> {
  await page.evaluate((tk) => {
    // Preenche o textarea oculto do reCAPTCHA
    const textarea = document.querySelector('#g-recaptcha-response') as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.style.display = 'block';
      textarea.value = tk;
    }

    // Também tenta em iframes (reCAPTCHA pode estar em um iframe)
    const textareas = document.querySelectorAll('textarea[id*="g-recaptcha-response"]');
    textareas.forEach((ta) => {
      (ta as HTMLTextAreaElement).value = tk;
    });

    // Chama o callback do reCAPTCHA se existir
    if (typeof (window as any).___grecaptcha_cfg !== 'undefined') {
      const cfg = (window as any).___grecaptcha_cfg;
      if (cfg.clients) {
        for (const clientKey of Object.keys(cfg.clients)) {
          const client = cfg.clients[clientKey];
          // Navega pela estrutura interna para encontrar o callback
          try {
            const traverse = (obj: any): void => {
              if (!obj || typeof obj !== 'object') return;
              for (const key of Object.keys(obj)) {
                if (typeof obj[key] === 'function' && key.length < 5) {
                  try { obj[key](tk); } catch { /* ignore */ }
                }
                if (typeof obj[key] === 'object') traverse(obj[key]);
              }
            };
            traverse(client);
          } catch { /* ignore */ }
        }
      }
    }
  }, token);
}

/**
 * Detecta se a página é um checkpoint de CAPTCHA e tenta resolver
 * automaticamente via CapSolver.
 * Retorna true se o CAPTCHA foi resolvido com sucesso.
 */
export async function handleCaptchaIfPresent(page: Page): Promise<boolean> {
  const url = page.url();
  if (!url.includes('checkpoint') && !url.includes('challenge')) {
    return false;
  }

  console.log('    🔍 Checkpoint de segurança detectado, tentando bypass...');

  const siteKey = await extractRecaptchaSiteKey(page);
  if (!siteKey) {
    // Tenta encontrar no iframe
    const frames = page.frames();
    for (const frame of frames) {
      const frameSiteKey = await frame.evaluate(() => {
        const el = document.querySelector('[data-sitekey]');
        return el?.getAttribute('data-sitekey') ?? null;
      }).catch(() => null);
      if (frameSiteKey) {
        return await attemptBypass(page, url, frameSiteKey);
      }
    }
    console.log('    ⚠️  Não foi possível encontrar o site key do reCAPTCHA.');
    return false;
  }

  return attemptBypass(page, url, siteKey);
}

async function attemptBypass(page: Page, websiteURL: string, siteKey: string): Promise<boolean> {
  console.log(`    🔑 Site key encontrado: ${siteKey.substring(0, 20)}...`);

  const token = await solveRecaptchaV2(websiteURL, siteKey);
  if (!token) return false;

  await injectRecaptchaToken(page, token);

  // Tenta submeter o formulário
  await page.waitForTimeout(1000);

  // Clica em botões de submit/verificar se existirem
  const submitSelectors = [
    'button#captcha-submit',
    'input[type="submit"]',
    'button[type="submit"]',
    'button:has-text("Verificar")',
    'button:has-text("Submit")',
  ];

  for (const sel of submitSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1000 })) {
        await btn.click();
        break;
      }
    } catch { /* try next */ }
  }

  // Aguarda navegação
  try {
    await page.waitForURL(/\/(feed|jobs|mynetwork|in\/)/, { timeout: 15000 });
    return true;
  } catch {
    console.log('    ⚠️  Token injetado mas a página não redirecionou.');
    return false;
  }
}

export function hasCaptchaSolverKey(): boolean {
  return !!getApiKey();
}
