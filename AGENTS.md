# AGENTS.md

## Cursor Cloud specific instructions

### Overview

VagaBot AI is a CLI-based AI job application agent (Node.js + TypeScript). It scrapes LinkedIn job postings via Playwright, analyzes resume compatibility via OpenAI, and generates ATS-optimized resumes. No web server, no Docker, no microservices.

### Key commands

See `package.json` scripts and `README.md` for full documentation. Quick reference:

- **Install deps:** `npm install`
- **Build (lint/type-check):** `npm run build` (runs `tsc`)
- **Tests:** `npm test` (currently a no-op placeholder)
- **Dev run (single URL):** `npm run dev -- "<LINKEDIN_JOB_URL>"`
- **Dev run (batch search):** `npm run dev -- search "<query>"`
- **Dev run (default keywords):** `npm run dev`

### Environment variables

Copy `.env.example` to `.env`. The only required secret is `OPENAI_API_KEY`. Without it, scraping and search still work, but analysis/adaptation steps will fail with a 401.

### Playwright / Chromium

After `npm install`, Chromium must be installed separately:

```
npx playwright install --with-deps chromium
```

The update script handles this automatically. If Chromium fails to launch at runtime, re-run the command above.

### SQLite (better-sqlite3)

`better-sqlite3` is a native addon compiled during `npm install`. It requires `python3`, `make`, and `g++` on the system. The VM image already has these. The database file `data/jobs.db` is created automatically at runtime.

### Gotchas

- The app validates `OPENAI_API_KEY` at startup. If the `.env` value is the placeholder from `.env.example`, the app will start but OpenAI calls will return 401 errors. The scraper/search modules still function independently.
- Playwright launches headless Chromium. No display server (X11/Wayland) is needed.
- LinkedIn scraping (`scraper.ts`) uses `waitUntil: 'networkidle'` which can timeout (~30s) on some job URLs due to LinkedIn's anti-bot measures. The search module (`search.ts`) uses `waitUntil: 'domcontentloaded'` and is more reliable. Intermittent scraper timeouts are expected and handled gracefully in the batch pipeline.
- There is no ESLint or Prettier config. `tsc` (via `npm run build`) is the only static analysis tool.
