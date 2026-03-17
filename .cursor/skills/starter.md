# VagaBot AI — Cloud Agent Starter Skill

Use this skill whenever you need to set up, run, test, or debug the VagaBot AI codebase inside a Cursor Cloud agent environment.

---

## Quick Environment Setup

```bash
# 1. Install Node dependencies (includes native better-sqlite3 addon)
cd /workspace && npm install

# 2. Install Playwright's headless Chromium
npx playwright install --with-deps chromium

# 3. Create .env from template (if not already present)
cp -n .env.example .env
```

### Environment Variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes | placeholder | The app throws at startup if missing. Without a real key, OpenAI calls return 401; scraping/search still work. |
| `DEFAULT_SEARCH_LIMIT` | No | `20` | Max jobs processed per keyword in the default (no-args) batch run. |

Set secrets in the **Cursor Dashboard → Cloud Agents → Secrets** panel so they persist across runs. They are injected as env vars automatically.

### Mocking / Working Without `OPENAI_API_KEY`

There is no built-in mock mode. If you do not have a valid key:

- **Scraper and Search modules work independently** — they only need Playwright/Chromium.
- **Analyzer, Adapter, and Composer will fail** with a 401 from the OpenAI SDK.
- To test OpenAI-dependent modules without a key, you can temporarily stub the call by returning a hard-coded JSON response matching `AnalysisResult` from `src/analyzer.ts`:

```ts
// Example stub return value for analyzeJob():
{ score: 8, relevant: true, reason: "Strong match", keywords: ["k1","k2","k3","k4","k5","k6","k7","k8","k9","k10"] }
```

---

## Build & Static Analysis

```bash
npm run build   # runs tsc — the ONLY static analysis tool
```

- There is no ESLint/Prettier. `tsc` is the single gate.
- Output goes to `dist/`. Source is `src/` with strict mode enabled.
- Always run `npm run build` after editing `.ts` files to verify the project compiles cleanly.

---

## Codebase Areas & Testing Workflows

### 1. LinkedIn Search (`src/search.ts`)

**What it does:** Builds a LinkedIn jobs search URL with filters (remote, Brazil, 30 days, mid/senior, full-time), navigates with Playwright, and extracts canonical job URLs.

**How to test in isolation:**

```bash
npx ts-node src/search.ts "React Developer"
```

**Expected output:** JSON array of `https://www.linkedin.com/jobs/view/<ID>` URLs, a count, and the search URL used.

**What can go wrong:**
- LinkedIn anti-bot blocks — returns 0 URLs or throws a timeout. This is expected and intermittent.
- Chromium not installed — `browserType.launch` error. Fix: `npx playwright install --with-deps chromium`.

**Verify success:** non-empty URL array in stdout, exit code 0.

---

### 2. Job Scraper (`src/scraper.ts`)

**What it does:** Opens a single LinkedIn job page, waits for `networkidle`, and extracts title, company, location, and description via CSS selectors.

**How to test in isolation:**

```bash
npx ts-node src/scraper.ts "https://www.linkedin.com/jobs/view/4371177488"
```

**Expected output:** JSON object with `{ title, company, location, description, url }`.

**What can go wrong:**
- `waitUntil: 'networkidle'` timeout (~30s) — LinkedIn is aggressive with bot detection. Intermittent, handled gracefully in the batch pipeline.
- Selector `h1.top-card-layout__title` not found — page structure may have changed.

**Verify success:** JSON with non-empty `title` and `description`, exit code 0.

---

### 3. Job Analyzer (`src/analyzer.ts`)

**What it does:** Sends the base resume (`data/nikson-curriculo-pt.md`) and scraped job data to OpenAI (`gpt-4.1-mini`, temperature 0). Returns `{ score, relevant, reason, keywords }`.

**Requires:** Valid `OPENAI_API_KEY`.

**How to test in isolation:**

```bash
npx ts-node -r dotenv/config src/analyzer.ts "https://www.linkedin.com/jobs/view/4371177488"
```

This internally calls `scrapeJob()` first, then `analyzeJob()`.

**Expected output:** JSON with `score` (0-10), `relevant` (boolean), `reason` (string), `keywords` (array of 10 strings).

**Verify success:** Valid JSON with exactly those four fields, exit code 0.

---

### 4. Resume Adapter (`src/adapter.ts`)

**What it does:** Sends the original resume + analysis keywords to OpenAI (`gpt-4.1`, temperature 0.2). Writes an ATS-optimized resume to `data/outputs/{company}-{date}-resume.md`.

**Requires:** Valid `OPENAI_API_KEY`. No standalone CLI — tested through the main pipeline.

**How to test:**

```bash
# Run the full single-URL pipeline
npx ts-node -r dotenv/config src/index.ts "https://www.linkedin.com/jobs/view/4371177488"

# Then check output
ls data/outputs/
```

**Verify success:** A new `.md` file appears in `data/outputs/` with an adapted resume.

---

### 5. Email Composer (`src/composer.ts`)

**What it does:** Generates an application email via OpenAI. Currently **commented out** in the main flow.

**To test:** Uncomment the `composeEmail` import and call in `src/index.ts`, then run the single-URL pipeline. Look for `{company}-{date}-email.txt` in `data/outputs/`.

---

### 6. Storage / SQLite (`src/storage.ts`)

**What it does:** Manages a SQLite database at `data/jobs.db` for URL deduplication and job detail persistence.

**How to verify:**

```bash
# After running any pipeline that processes jobs:
npx ts-node -e "
const Database = require('better-sqlite3');
const db = new Database('data/jobs.db');
console.log(db.prepare('SELECT COUNT(*) as count FROM jobs').get());
console.log(db.prepare('SELECT url, title, score, relevant FROM jobs ORDER BY id DESC LIMIT 5').all());
"
```

**Reset the database** (to re-process previously seen URLs):

```bash
rm data/jobs.db
```

**Verify success:** Row count increases after a pipeline run; `title`, `score`, `relevant` columns are populated for processed jobs.

---

### 7. Main Orchestrator (`src/index.ts`)

Three CLI modes:

| Mode | Command | What it runs |
|---|---|---|
| Default batch | `npm run dev` | All `SEARCH_KEYWORDS` with `DEFAULT_SEARCH_LIMIT` |
| Single URL | `npm run dev -- "<URL>"` | scrape → analyze → adapt for one job |
| Search query | `npm run dev -- search "query"` | search → scrape → analyze → adapt for each result |

The default batch mode is long-running (many keywords × many jobs). For quick testing, prefer single-URL or search with a small limit:

```bash
npm run dev -- search 2 "React Developer"
```

---

## End-to-End Smoke Test Checklist

Run these steps in order to verify the full environment:

```bash
# 1. Build compiles cleanly
npm run build

# 2. Search returns URLs (Playwright + Chromium OK)
npx ts-node src/search.ts "Frontend Engineer" 2>&1 | head -5

# 3. Scraper extracts job data (single page)
npx ts-node src/scraper.ts "https://www.linkedin.com/jobs/view/4371177488" 2>&1 | head -3

# 4. Full pipeline (needs OPENAI_API_KEY)
npm run dev -- search 1 "React Developer"

# 5. Database was populated
npx ts-node -e "const D=require('better-sqlite3');const d=new D('data/jobs.db');console.log(d.prepare('SELECT COUNT(*) as c FROM jobs').get())"

# 6. Output files were generated
ls -la data/outputs/
```

Steps 1-3 work without `OPENAI_API_KEY`. Steps 4-6 require a valid key.

---

## Common Pitfalls

| Issue | Cause | Fix |
|---|---|---|
| `browserType.launch: Executable doesn't exist` | Chromium not installed | `npx playwright install --with-deps chromium` |
| `Error: Variável de ambiente obrigatória ausente: OPENAI_API_KEY` | Missing `.env` or key not set | `cp .env.example .env` then set a real key, or add it in Cursor Secrets |
| OpenAI 401 | Placeholder key in `.env` | Replace with a valid API key |
| Scraper timeout on LinkedIn | Anti-bot detection | Expected & intermittent; the batch pipeline catches and skips. Retry or try a different URL. |
| `better-sqlite3` build failure | Missing native build tools | `apt-get install -y python3 make g++` then `npm rebuild better-sqlite3` |
| Database deduplication skips a URL | URL already in `data/jobs.db` | Delete `data/jobs.db` to reset |

---

## Updating This Skill

When you discover new testing tricks, runbook knowledge, or workflow shortcuts for this codebase, update this file following these guidelines:

1. **New module or CLI mode** — Add a new subsection under "Codebase Areas & Testing Workflows" with the same structure: what it does, how to test, expected output, what can go wrong, verify success.
2. **New env var or feature flag** — Add a row to the "Environment Variables" table and note any testing implications.
3. **New pitfall** — Add a row to "Common Pitfalls" with cause and fix.
4. **New smoke-test step** — Append to the "End-to-End Smoke Test Checklist" in the correct order.
5. **Changed dependency or setup step** — Update "Quick Environment Setup" and note the reason in a commit message.

Keep this file concise and command-oriented. Cloud agents need actionable commands, not prose.
