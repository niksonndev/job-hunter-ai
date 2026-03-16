# vaga-bot-ai (Job Agent 24x7)

Agente de IA em Node + TypeScript para buscar vagas na internet, analisar relevância em relação ao seu currículo, adaptar o currículo com palavras‑chave otimizadas para sistemas ATS e gerar um e-mail pronto para envio — tudo de forma automatizada e contínua.

## Ideia geral

Como desenvolvedor, a proposta é ter um **agent de emprego 24x7** que:

- **Busca vagas** em diferentes fontes online.
- **Lê e entende** a descrição da vaga.
- **Compara** a vaga com o seu currículo base.
- **Adapta o currículo** inserindo e priorizando palavras‑chave relevantes para sistemas de triagem automática (ATS).
- **Gera um e-mail** de candidatura personalizado.
- (Futuro) **Envia o e-mail** automaticamente para o contato da vaga.

Tudo isso rodando de forma recorrente (por exemplo, via cron job, scheduler ou worker), para que você tenha um fluxo constante de candidaturas personalizadas.

## Stack técnica

- **Runtime**: Node.js + TypeScript
- **Execução TS**: `ts-node`
- **IA**: `@anthropic-ai/sdk`
- **Automação de browser / scraping avançado**: `playwright`
- **Configuração de ambiente**: `dotenv`

## Estrutura de pastas

```text
job-agent/
├── src/
│   ├── scraper.ts        # busca a vaga e extrai dados
│   ├── analyzer.ts       # filtra relevância
│   ├── adapter.ts        # adapta o currículo
│   ├── composer.ts       # gera o email
│   └── index.ts          # orquestra tudo
├── data/
│   ├── resume.md         # seu currículo base aqui
│   └── outputs/          # arquivos gerados ficam aqui
├── .env                  # variáveis de ambiente (não versionado)
├── .env.example          # exemplo de config de ambiente
├── package.json
└── tsconfig.json
```

## Fluxo do agente

1. **Scraper (`scraper.ts`)**
   - Recebe uma URL de vaga ou uma fonte de pesquisa.
   - Usa HTTP ou Playwright para carregar a página.
   - Extrai título, descrição, empresa, localização, requisitos, etc.

2. **Analyzer (`analyzer.ts`)**
   - Carrega seu currículo base de `data/resume.md`.
   - Compara o texto da vaga com seu perfil, experiência e skills.
   - Calcula um **score de relevância** e uma lista de **razões** (por que é relevante / não é).
   - Pode descartar vagas com score abaixo de um threshold.

3. **Adapter (`adapter.ts`)**
   - Usa o SDK da Anthropic para:
     - Gerar uma versão adaptada do currículo focada na vaga.
     - Inserir e reorganizar **palavras‑chave** importantes para o ATS (skills, tecnologias, senioridade, etc.).
   - Mantém o estilo e a veracidade do seu currículo, apenas enfatizando melhor o que a vaga pede.

4. **Composer (`composer.ts`)**
   - Gera um **email de candidatura**:
     - Assunto personalizado (vaga, empresa, posição).
     - Corpo do email com introdução, resumo do fit, e call‑to‑action.
   - Pode incluir trechos do currículo adaptado ou anexos (em fase futura).

5. **Orquestração (`index.ts`)**
   - Valida variáveis de ambiente.
   - Define a fonte/URL das vagas ou um loop de processamento.
   - Chama `scraper` → `analyzer` → `adapter` → `composer`.
   - Salva saídas em `data/outputs/` (ex: `curriculo-<id-vaga>.md`, `email-<id-vaga>.md`).

## Variáveis de ambiente

Arquivo `.env` (baseado em `.env.example`):

```bash
ANTHROPIC_API_KEY=coloque_sua_chave_aqui
```

## Scripts principais

No `package.json`:

- **`npm run dev`** – roda o `src/index.ts` com `ts-node` (modo desenvolvimento).
- **`npm run build`** – compila TypeScript para `dist/` usando `tsc`.

## Roadmap de features

- [ ] Implementar scraping real de vagas (ex: LinkedIn, Indeed, Gupy, Greenhouse, etc., respeitando ToS).
- [ ] Implementar análise de relevância usando IA (Anthropic) + heurísticas.
- [ ] Implementar adaptação de currículo com foco em ATS (palavras‑chave, formatação, hard/soft skills).
- [ ] Implementar geração de e-mail de candidatura multilíngue (PT/EN).
- [ ] Persistir histórico de vagas processadas (para evitar duplicidade).
- [ ] Automatizar o envio de e-mails (ex: SMTP, Gmail API, etc.).
- [ ] Adicionar scheduler para rodar 24x7 (cron, worker, Docker, etc.).

## Como começar

1. Instale as dependências:

```bash
npm install
```

2. Copie `.env.example` para `.env` e coloque sua `ANTHROPIC_API_KEY`.

3. Coloque seu currículo base em `data/resume.md` (Markdown).

4. Rode em modo desenvolvimento:

```bash
npm run dev
```

5. Ajuste as funções em `scraper.ts`, `analyzer.ts`, `adapter.ts` e `composer.ts` para a lógica real desejada.

---

Este projeto existe para ser o seu **agente pessoal de vagas**, rodando continuamente e otimizando suas candidaturas para maximizar a chance de passar pelos filtros automáticos e chegar de fato nas mãos de recrutadores.
