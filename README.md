## VagaBot AI

Agente de IA em Node + TypeScript que lê uma vaga do LinkedIn, analisa compatibilidade com o seu currículo e reescreve o currículo otimizado para ATS. Opcionalmente, pode gerar um email de candidatura pronto para enviar.

### Ideia geral

Como desenvolvedor, a proposta é ter um **agent de emprego 24x7** que:

- **Lê uma vaga específica** (URL do LinkedIn).
- **Lê e entende** a descrição da vaga.
- **Compara** a vaga com o seu currículo base (`data/nikson-curriculo-pt.md`).
- **Adapta o currículo** inserindo e priorizando palavras‑chave relevantes para sistemas ATS.
- **Gera um e-mail** de candidatura com tom de dev sênior confiante.

Hoje o fluxo é executado on‑demand via CLI; no futuro pode rodar em loop/scheduler.

### Stack técnica

- **Runtime**: Node.js + TypeScript
- **Execução TS**: `ts-node`
- **IA**: SDK oficial da OpenAI (`openai`)
- **Automação de browser / scraping**: `playwright` (LinkedIn job page)
- **Storage local**: `better-sqlite3` (SQLite embutido, sem servidor)
- **Configuração de ambiente**: `dotenv`

### Estrutura de pastas

```text
vaga-bot-ai/
├── src/
│   ├── scraper.ts    # busca uma vaga (LinkedIn) e extrai JobData
│   ├── search.ts     # busca pública de vagas no LinkedIn (lista de URLs canônicas)
│   ├── analyzer.ts   # analisa compatibilidade currículo x vaga (JSON, score, keywords)
│   ├── adapter.ts    # reescreve currículo otimizado para ATS e salva .md
│   ├── composer.ts   # (opcional) gera email de candidatura e salva .txt
│   ├── storage.ts    # storage local em SQLite para URLs de vagas (deduplicação)
│   └── index.ts      # CLI que orquestra tudo (URL única ou busca em lote)
├── data/
│   ├── nikson-curriculo-pt.md     # currículo base (PT)
│   ├── nikson-curriculum-en.md    # currículo base (EN) – opcional
│   ├── jobs.db                    # banco SQLite local (gerado em runtime)
│   └── outputs/                   # arquivos gerados (currículos e emails)
├── .env                  # variáveis de ambiente (não versionado)
├── .env.example          # exemplo de config de ambiente
├── package.json
└── tsconfig.json
```

### Fluxo do agente

1. **Scraper (`scraper.ts`)**
   - Recebe **apenas** a URL de uma vaga do LinkedIn.
   - Usa Playwright (com `headless: false` e user‑agent customizado).
   - Aguarda seletores críticos (título, empresa, localização, descrição).
   - Limpa texto (remove “Show more/less”, normaliza quebras de linha).
   - Retorna um `JobData` tipado:
     - `title`, `company`, `location`, `description`, `url`.

2. **Analyzer (`analyzer.ts`)**
   - Lê `data/nikson-curriculo-pt.md`.
   - Monta um prompt com:
     - Currículo base.
     - Título, empresa e descrição da vaga.
   - Usa OpenAI (`gpt-4.1-nano`) com um **prompt de sistema rígido** para responder somente JSON.
   - Faz `JSON.parse` com `try/catch`, logando a resposta raw se der erro.
   - Valida campos obrigatórios e retorna um `AnalysisResult`:

```ts
export interface AnalysisResult {
  relevant: boolean;
  category: 'frontend' | 'analytics' | 'fullstack' | 'backend';
}
```

   - Também expõe um mini‑CLI:
     - `npx ts-node -r dotenv/config src/analyzer.ts "<URL_DA_VAGA>"`  
       (faz scrape + análise e imprime o JSON).

3. **Adapter (`adapter.ts`)**
   - Entrada: `adaptResume(job: JobData, analysis: AnalysisResult): Promise<string>`.
   - Lê o currículo base `data/nikson-curriculo-pt.md`.
   - Usa um modelo mais forte (`gpt-4.1` / gpt‑4o equivalente) com um prompt de sistema focado em:
     - Manter 100% das informações verdadeiras.
     - Incorporar naturalmente os requisitos da vaga onde fizer sentido.
     - Reordenar/priorizar seções de skills para refletir os requisitos da vaga.
     - Manter **formato markdown** e retornar só o currículo reescrito.
   - Salva o currículo adaptado em:
     - `data/outputs/{company-slug}-{YYYY-MM-DD}-resume.md`
   - Retorna o currículo reescrito como `string`.

4. **Composer (`composer.ts`)** (opcional, atualmente desabilitado no fluxo padrão)
   - Entrada: `composeEmail(job: JobData, analysis: AnalysisResult): Promise<string>`.
   - Usa um modelo leve (`gpt-4.1-nano`).
   - Prompt do sistema orientado a:
     - Email de candidatura direto, confiante, não genérico.
     - Sem clichês (“venho por meio deste”, etc.).
     - Retornar apenas o corpo do email (sem assunto/saudação).
   - Prompt do usuário inclui:
     - Título da vaga, empresa e categoria da vaga.
   - Gera um email com no máximo 4 parágrafos, terminando com call to action clara.
   - Salva em:
     - `data/outputs/{company-slug}-{YYYY-MM-DD}-email.txt`
   - Retorna o corpo do email como `string`.

5. **Orquestração (`index.ts`)**
   - Carrega `.env` (`dotenv/config`) e valida `OPENAI_API_KEY`.
   - Expõe dois modos de execução via CLI:
     1. **Modo URL única** (fluxo original)
        - Comando:
          ```bash
          npm run dev -- "https://www.linkedin.com/jobs/view/4371177488"
          ```
        - Fluxo:
          1. `scrapeJob(url)`
          2. `analyzeJob(job)`
          3. Se `analysis.relevant === false`, loga:
             - `⚠️  Vaga não relevante (category: X) — encerrando.`
             - E encerra.
          4. `adaptResume(job, analysis)`
          5. (opcional) `composeEmail(job, analysis)` — atualmente comentado no código principal
     2. **Modo busca em lote no LinkedIn**
        - Comando:
          ```bash
          npm run dev -- search "desenvolvedor backend node"
          ```
        - Fluxo:
          1. `searchJobs(query)` em `search.ts` monta a URL pública de busca de vagas do LinkedIn com filtros (Brasil, remoto, últimos 30 dias, pleno+sênior, full‑time) e retorna um array de URLs canônicas no formato:
             - `https://www.linkedin.com/jobs/view/<JOB_ID>`
          2. Para cada URL retornada:
             - `saveJobUrl(url)` em `storage.ts` tenta inserir a URL no SQLite (`data/jobs.db`):
               - Se já existir, a vaga é **pulada** (`⏭️  Vaga já processada, pulando: ...`).
               - Se for nova, segue o pipeline.
             - `scrapeJob(url)` para extrair `JobData`.
             - `analyzeJob(job)` para obter `AnalysisResult`.
             - Se a vaga for pouco relevante, apenas loga e segue para a próxima.
             - Se for relevante:
               - `adaptResume(job, analysis)` → currículo adaptado salvo em `data/outputs/...-resume.md`.
               - `composeEmail(job, analysis)` → email salvo em `data/outputs/...-email.txt`.
          3. Loga o progresso de cada vaga:
             - `🔍 Processando vaga: <URL>`
             - `📊 Analisando compatibilidade...`
             - `✍️  Adaptando currículo...`
             - `📧 Gerando email...`
             - `✅ Vaga processada com sucesso! { title, company, category, url }`

### Variáveis de ambiente

Arquivo `.env` (baseado em `.env.example`):

```bash
OPENAI_API_KEY=coloque_sua_chave_aqui
DEFAULT_SEARCH_LIMIT=20
```

### Scripts principais

No `package.json`:

- **`npm run dev`** – roda o `src/index.ts` com `ts-node` (modo desenvolvimento / CLI principal).
- **`npm run build`** – compila TypeScript para `dist/` usando `tsc`.
- **`npm test`** – placeholder atual (apenas imprime "Nenhum teste definido").

#### Opções de execução do `npm run dev`

O comportamento depende do primeiro argumento após `--`:

- **Sem argumentos**: roda buscas padrão em lote para todas as categorias de `SEARCH_KEYWORDS`.
  - Exemplo:
    ```bash
    npm run dev
    ```

- **Categoria** (`frontend`, `backend`, `fullstack`, `webAnalytics`): roda só aquela categoria.
  - Exemplo:
    ```bash
    npm run dev -- frontend
    ```

- **Busca por termo** (`search` ou `busca`): executa busca no LinkedIn e processa as vagas encontradas.
  - Exemplos:
    ```bash
    npm run dev -- search "React Developer"
    npm run dev -- busca "engenheiro de dados"
    ```

- **Busca com limite explícito**: `search|busca <limite> <termo>`.
  - Exemplo:
    ```bash
    npm run dev -- search 10 "React Developer"
    ```

- **URL única de vaga**: qualquer argumento que não seja categoria e nem `search|busca` é tratado como URL.
  - Exemplo:
    ```bash
    npm run dev -- "https://www.linkedin.com/jobs/view/4371177488"
    ```

#### Variáveis que influenciam os scripts

- `OPENAI_API_KEY` (obrigatória para análise com IA).
- `DEFAULT_SEARCH_LIMIT` (limite padrão quando você não passa limite no comando).
- `MAX_SEARCH_RESULTS` (limite máximo de URLs retornadas pela busca).

#### Integração opcional com Google Sheets

Quando configurada, cada vaga relevante salva no SQLite também é adicionada na planilha:

- `GOOGLE_SHEETS_SPREADSHEET_ID`
- `GOOGLE_SHEETS_WORKSHEET_NAME` (ex.: `jobs`)
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`

Observação sobre a chave privada no `.env`:

- mantenha entre aspas duplas e com `\n` literal, por exemplo:
  ```bash
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
  ```

### Como rodar o agente ponta a ponta

1. Instale as dependências:

```bash
npm install
```

2. Copie `.env.example` para `.env` e coloque sua `OPENAI_API_KEY`.

3. Coloque seu currículo base em `data/nikson-curriculo-pt.md` (Markdown).

4. Modos de execução:

#### 4.1. Pipeline completo para **uma URL específica**

```bash
npm run dev -- "https://www.linkedin.com/jobs/view/4371177488"
```

Isso irá:

- Scrapar a vaga do LinkedIn.
- Analisar compatibilidade currículo x vaga.
- Gerar um currículo adaptado para ATS em `data/outputs/...-resume.md`.
- (Opcional, se reabilitar no código) gerar um email de candidatura em `data/outputs/...-email.txt`.

#### 4.2. Busca automática de vagas + processamento em lote

```bash
npm run dev -- search "desenvolvedor backend node"
```

Isso irá:

- Abrir uma busca pública de vagas do LinkedIn para o termo informado (Brasil, remoto, últimos 30 dias, pleno+sênior, full‑time).
- Extrair os links das vagas, normalizar para o formato `https://www.linkedin.com/jobs/view/<JOB_ID>` e **eliminar duplicados**.
- Armazenar cada URL em `data/jobs.db` (SQLite) para não reprocessar a mesma vaga em execuções futuras.
- Para cada vaga nova:
  - Rodar scraping, análise de compatibilidade e adaptação de currículo.
  - (Opcional, se reabilitar no código) gerar email de candidatura.
  - Salvar currículo (e, opcionalmente, o email) em `data/outputs/`.

---

Este projeto existe para ser o seu **agente pessoal de vagas**, otimizando currículo e comunicação para maximizar a chance de passar pelos filtros automáticos (ATS) e chegar de fato nas mãos de recrutadores.
