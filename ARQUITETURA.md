## Visão geral da arquitetura

Este projeto implementa um **agente de vagas** em Node.js + TypeScript que:

- Faz scraping de vagas do LinkedIn, gerando um objeto `JobData`.
- Analisa a compatibilidade entre vaga e currículo base, produzindo um `AnalysisResult`.
- Adapta o currículo em Markdown com foco em ATS.
- (Opcionalmente) gera um email de candidatura personalizado.
- Orquestra tudo através de uma CLI única (`src/index.ts`) que pode operar em **modo URL única** ou **modo busca em lote**.

A arquitetura é composta por módulos coesos em `src/` responsáveis por scraping, busca, análise, adaptação de currículo, composição de email e storage local em SQLite.

## Stack tecnológico completo

- **Linguagem**: TypeScript
- **Runtime**: Node.js
- **Execução TS em desenvolvimento**: `ts-node`
- **IA / LLM**: SDK oficial da OpenAI (`openai`) – modelos `gpt-4.1-mini` (análise) e `gpt-4.1`/equivalente (adaptação de currículo)
- **Automação de browser / scraping**: `playwright`
- **Banco de dados**: SQLite via `better-sqlite3`
- **Gerenciamento de dependências / scripts**: `npm`
- **Configuração de ambiente**: `dotenv`
- **CLI**: `src/index.ts` executado via `npm run dev` ou buildado com `npm run build`

## Todas as variáveis de ambiente

Arquivo `.env` (baseado em `.env.example`):

- `OPENAI_API_KEY`: chave de API da OpenAI usada para chamadas de LLM.
- `DEFAULT_SEARCH_LIMIT`: número padrão máximo de vagas retornadas na busca pública do LinkedIn (usada em `search.ts`).

Qualquer nova variável de ambiente deve ser documentada em `.env.example` e descrita nesta seção.

## Estrutura do diretório de conteúdo

Diretórios principais:

- `src/`
  - `scraper.ts`: lê uma URL de vaga do LinkedIn e retorna `JobData`.
  - `search.ts`: executa buscas públicas de vagas no LinkedIn e retorna URLs canônicas.
  - `analyzer.ts`: analisa compatibilidade currículo x vaga e retorna `AnalysisResult`.
  - `adapter.ts`: reescreve o currículo em Markdown otimizado para ATS.
  - `composer.ts`: gera email de candidatura (opcional).
  - `storage.ts`: gerencia o banco SQLite (`data/jobs.db`) para deduplicar vagas.
  - `index.ts`: ponto de entrada da CLI, orquestra todo o pipeline.
- `data/`
  - `nikson-curriculo-pt.md`: currículo base em português.
  - `nikson-curriculum-en.md`: currículo base em inglês (opcional).
  - `jobs.db`: banco SQLite com URLs de vagas já processadas.
  - `outputs/`: destino de currículos adaptados (`*-resume.md`) e emails (`*-email.txt`).

## Serviços, jobs e models de cada app

### Serviços principais

- `scrapeJob(url: string): Promise<JobData>` em `scraper.ts`
  - Responsável por abrir a página da vaga, aguardar os seletores críticos e normalizar o texto.
- `searchJobs(query: string): Promise<string[]>` em `search.ts`
  - Monta a URL de busca pública do LinkedIn com filtros (Brasil, remoto, últimos 30 dias, pleno+sênior, full‑time) e retorna URLs canônicas de vagas.
- `analyzeJob(job: JobData): Promise<AnalysisResult>` em `analyzer.ts`
  - Usa o currículo base + descrição da vaga para gerar score de compatibilidade e keywords ATS.
- `adaptResume(job: JobData, analysis: AnalysisResult): Promise<string>` em `adapter.ts`
  - Reescreve o currículo em Markdown incorporando as keywords relevantes.
- `composeEmail(job: JobData, analysis: AnalysisResult): Promise<string>` em `composer.ts`
  - Gera um email de candidatura conciso e direto (opcional).
- `saveJobUrl(url: string): { inserted: boolean }` em `storage.ts`
  - Tenta inserir a URL no SQLite e indica se a vaga é nova ou já conhecida.

### Jobs / fluxos

- **Job de URL única**
  - Entrada: URL de uma vaga do LinkedIn.
  - Passos: `scrapeJob` → `analyzeJob` → (se relevante) `adaptResume` → (opcional) `composeEmail`.
- **Job de busca em lote**
  - Entrada: termo de busca (ex.: `"desenvolvedor backend node"`).
  - Passos: `searchJobs` → `saveJobUrl` (para cada URL) → `scrapeJob` → `analyzeJob` → `adaptResume` (para vagas relevantes) → `composeEmail` (opcional).

### Models principais

- `JobData`
  - `title: string`
  - `company: string`
  - `location: string`
  - `description: string`
  - `url: string`
- `AnalysisResult`
  - `score: number` (0 a 10)
  - `relevant: boolean` (true se `score >= 7`)
  - `reason: string` (1‑2 frases com o porquê do score)
  - `keywords: string[]` (exatamente 10 palavras‑chave ATS da vaga)

## 12 "common hurdles" com soluções documentadas

1. **Resposta da OpenAI não é JSON válido**
   - Solução: logar a resposta bruta, envolver `JSON.parse` em `try/catch` e, em caso de falha, re-tentar com um prompt mais restritivo ou descartar a vaga.
2. **Timeout / falha no Playwright ao carregar página**
   - Solução: aumentar timeouts, validar seletores críticos antes de seguir e implementar re-tentativas com backoff.
3. **LinkedIn bloqueando acesso (detecção de bot)**
   - Solução: usar `user-agent` customizado, `headless: false`, intervalos aleatórios entre requisições e respeitar limites.
4. **Quebra de layout na descrição da vaga**
   - Solução: normalizar quebras de linha e remover textos auxiliares (“mostrar mais/menos”) antes de enviar para o LLM.
5. **Vaga em idioma diferente do currículo base**
   - Solução: detectar idioma da descrição (heurística simples) e adaptar o prompt para pedir tradução ou priorizar vagas no mesmo idioma.
6. **Currículo gerado maior que o desejado**
   - Solução: ajustar prompt para limitar tamanho de seções e priorizar conteúdo essencial.
7. **Palavras‑chave ATS não utilizadas no currículo adaptado**
   - Solução: instruir explicitamente o modelo a usar todas as keywords sempre que fizer sentido, mantendo veracidade.
8. **Erro ao salvar arquivos em `data/outputs`**
   - Solução: garantir existência do diretório de saída na inicialização da CLI e tratar erros de escrita.
9. **Banco SQLite corrompido ou ausente**
   - Solução: criar o banco e as tabelas caso não existam; se corrompido, permitir recriação com backup opcional.
10. **Execução sem `OPENAI_API_KEY` configurada**
    - Solução: validar a variável de ambiente na inicialização e encerrar com mensagem clara se estiver ausente.
11. **Limite de vagas na busca muito alto (lentidão)**
    - Solução: usar `DEFAULT_SEARCH_LIMIT` em `.env` e permitir override via argumento de CLI.
12. **Reexecução de vagas já processadas**
    - Solução: usar `saveJobUrl` com constraint única no SQLite para pular URLs já presentes.

## 14 design patterns do projeto

1. **Pipeline / Orquestração**: `index.ts` coordena chamadas sequenciais, cada etapa com responsabilidade clara.
2. **Repository**: `storage.ts` encapsula acesso ao SQLite.
3. **Adapter**: `adapter.ts` adapta dados de entrada (vaga + análise) para o formato esperado (currículo ATS).
4. **Strategy via prompts**: diferentes prompts/modelos para análise (`analyzer.ts`) e adaptação (`adapter.ts`) e email (`composer.ts`).
5. **DTOs tipados**: `JobData` e `AnalysisResult` atuam como Data Transfer Objects entre módulos.
6. **Fail‑fast**: validação de `OPENAI_API_KEY` e de estrutura de dados antes de prosseguir.
7. **Command/CLI**: `index.ts` expõe comandos de alto nível (URL única, busca em lote).
8. **Logging estruturado**: logs com ícones e contexto por etapa do pipeline.
9. **Configuration as Code**: `.env.example` e `DEFAULT_SEARCH_LIMIT` controlam comportamento sem mudar código.
10. **Single Responsibility**: cada arquivo em `src/` foca em um papel único (scraper, analyzer, adapter, etc.).
11. **Separation of Concerns**: scraping, análise, storage e IO (filesystem) estão desacoplados.
12. **Template Method (implícito)**: o fluxo de processamento de uma vaga segue a mesma “template pipeline” com pequenos ajustes entre modos.
13. **Guard Clauses**: verificação de relevância (`analysis.relevant`) interrompe cedo o pipeline para vagas ruins.
14. **Idempotência via deduplicação**: o uso de SQLite com constraint de unicidade garante que a mesma vaga não seja reprocessada.

## Pipeline semanal completo com horários

Sugestão de rotina semanal para usar o agente em um contexto real de busca de vagas:

- **Segunda a sexta, 09:00–09:30** – Rodar busca em lote (`npm run dev -- search "<termo>"`) para termos principais de interesse.
- **Segunda a sexta, 09:30–10:00** – Revisar currículos e emails gerados em `data/outputs`, ajustar manualmente quando necessário.
- **Terça e quinta, 14:00–15:00** – Enviar candidaturas usando os currículos + emails gerados, registrar retorno em ferramenta externa (ex.: planilha).
- **Sábado, 10:00–11:00** – Revisar métricas (quantidade de vagas processadas, respostas recebidas), ajustar termos de busca e parâmetros.
- **Domingo, 18:00–18:30** – Manutenção leve: atualizar dependências, revisar prompts e checar se há erros recorrentes nos logs.

Os horários podem ser adaptados, mas a ideia é manter um ciclo semanal de **busca → geração → revisão → envio → análise**.

## Checklist pós-implementação

- [ ] Confirmar que `.env` está configurado com `OPENAI_API_KEY` e `DEFAULT_SEARCH_LIMIT`.
- [ ] Validar que `npm install` roda sem erros e que os scripts (`npm run dev`, `npm run build`) funcionam.
- [ ] Verificar se o scraping em `scraper.ts` ainda encontra todos os seletores necessários no LinkedIn.
- [ ] Rodar um fluxo completo de URL única e garantir que currículo adaptado seja salvo em `data/outputs`.
- [ ] (Opcional) Reabilitar e testar `composer.ts` para geração de emails.
- [ ] Verificar logs para identificar erros de JSON, timeouts e problemas de storage.
- [ ] Garantir que o SQLite (`data/jobs.db`) está criando e deduplicando URLs corretamente.
- [ ] Atualizar este documento (`ARQUITETURA.md`) sempre que houver mudanças significativas na arquitetura, stack ou processos.
