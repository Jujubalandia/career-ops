# Fontes remotas LATAM

Base de busca de boards remotos gratuitos que alimenta `data/pipeline.md` sem passar pelo `import-jobs.mjs` (Gupy, LinkedIn, Vagas.com) nem pelo `portals.yml`. Zero tokens: só enche a fila, quem avalia é o `/career-ops pipeline`.

## Uso

```bash
cp templates/remote-latam.example.yml remote-latam.yml   # camada de usuário (gitignored)
scripts/run-remote-latam-scan.sh --dry-run               # funil por fonte, não grava
scripts/run-remote-latam-scan.sh                          # grava as vagas novas na fila
JOBAGE=7 scripts/run-remote-latam-scan.sh                 # janela de 7 dias só nesta rodada
scripts/run-remote-latam-scan.sh --source getonbrd        # uma fonte (mesmo desligada)
scripts/run-remote-latam-scan.sh --verify --limit 20      # derruba links mortos, no máximo 20 linhas
```

Sem `remote-latam.yml`, o scanner usa o template (avisa no stderr). O wrapper roda no cron às 07:20 (runbook, seção 4); à mão, os comandos acima servem para dias perdidos.

O funil, em ordem (`node scripts/scan-remote-latam.mjs --dry-run` mostra uma linha por fonte):

| Etapa | O que faz |
|---|---|
| fetch | Chama o provider da fonte (`providers/<id>.mjs`, o mesmo contrato do `scan.mjs`) |
| título | `filters.include` e `filters.exclude` do catálogo |
| região | `lib/latam-eligibility.mjs`: `true`, `false` ou `unknown` |
| idade | Descarta o que passou de `--since` dias; sem data entra e é contado |
| dedup | URL normalizada e empresa+cargo contra fila, histórico e tracker; uma fonte não repete o que outra já pegou |
| `--verify` | `check-liveness.mjs`, descarta vaga morta |

Cada linha gravada leva `note: remote-latam:<fonte>` e, quando a região não ficou clara, `loc?`. As rodadas ficam em `logs/remote-latam.tsv`.

## Filtro de região

- **Aceita:** LATAM, América Latina/do Sul, Americas, Brasil, **São Paulo** (híbrido em SP é um alvo do seu perfil), Worldwide, Anywhere, Global, "Remote (Global)".
- **Rejeita:** "US only", "must be authorized to work in the US", "REMOTE (UK)", fuso CET/EET/GMT, vaga **presencial ou híbrida sem opção remota** (um "Toronto (Hybrid)" no próprio campo de local decide sozinho, mesmo que a descrição cite remoto), e **qualquer país ou região que não seja o Brasil** quando aparece sozinho ("Egypt", "China", "Europe", "Mexico"). A lista de países vem do `Intl.DisplayNames` do Node, sem tabela mantida à mão.
- **`unknown` (mantida, marcada `loc?`):** sem região no texto, ou "Global (US/CAN/EU/India)", que lista regiões em vez de dizer "mundo".
- Fusos dos EUA **não** são restrição (a sobreposição ET/CT serve ao seu perfil).

## Auditoria do `docs/rn-PORTALS.txt` (35 URLs)

Validada em 05/10/2026 com `curl` (status, `robots.txt`, feeds declarados na página).

| Grupo | URLs | Decisão |
|---|---|---|
| Já têm provider | remotive.com, nodesk.co, workingnomads.com, news.ycombinator.com | **Usadas** (`remotive`, `nodesk`, `workingnomads`, `hackernews`) |
| Espelhos do thread do HN | hnwork.app, nthesis.ai, dheerajck.github.io/hnwhoishiring, nchelluri.github.io/hnjobs, hnjobs.emilburzo.com | **Cobertas** pelo provider `hackernews` (mesma fonte) |
| RSS de vagas, sem provider | fossjobs.net (`/rss/all/`), opensourcejobhub.com (`/rss/`) | **Fora por ora**: boards de open source, pouca vaga de IA/dados; viram provider se você quiser |
| Termos proíbem scraping | remoterocketship.com | **Fora, por decisão de termos.** A seção 5 dos termos proíbe "scraping the Platform, running automated browser sessions" e monitora padrões automatizados. A única via permitida é a API oficial (`POST /api/openclaw/jobs`), que exige assinatura paga. Não é gratuito, então não entra |
| Sem feed de vagas | remoteleaf.com, remotesource.com, arc.dev | **Fora**. Só HTML |
| JSON-LD embutido | aigigjobs.com | **Usado** (`aigigjobs`), com filtro por classe. A decisão da fase 2 ("só crowd-work") foi revista: 33 de 94 vagas amostradas são engenharia de IA/ML, ciência ou engenharia de dados (ver "Classificação"). `robots.txt` permissivo com Crawl-delay de 5 s; não existe página de termos |
| Bloqueado ou com login | startup.jobs (403, `robots.txt` restritivo), ziprecruiter.com, indeed.com | **Fora** |
| Índices do GitHub | awesome-job-boards, remote-job-sites, remote-jobs-list, freehire, backend-br/vagas | **Usados na descoberta** (seção abaixo): 639 domínios sondados, 2 viraram provider |
| Índices não usados | remote-jobs (maurobonfietti, 1.531 links de empresas), remoteintech, awesome-ai-startups-hiring | **Fora**: listas de empresas, não de boards |
| Não são vagas | hiretalent.lat, latojobs.com (cadastro de candidato), arc.dev (onboarding), hireslink (relatório), Cloudflare careers (Lisboa) | **Fora** |

### Boards fora da lista, com provider e sinal LATAM

Entram no catálogo porque já existem, são gratuitos e trazem região:

| Provider | Situação |
|---|---|
| `getonbrd` | Ativo. Board nativo da América Latina (categorias `machine-learning-ai`, `programming`, `operations-management`) |
| `himalayas` | Ativo. Campo `locationRestrictions` separa "worldwide" de restrito |
| `jobicy` | Ativo. Campo `jobGeo` |
| `weworkremotely` | Ativo. RSS, local muitas vezes vazio |
| `remoteyeah` | Ativo. **Provider novo** (RSS). `<location>` estruturado: traz vagas "Brazil" e "Latin America" |
| `tryremotely` | Ativo. **Provider novo** (API oficial, sem chave). Ver "Limites" abaixo sobre profundidade |
| `aigigjobs` | Ativo. **Provider novo** (JSON-LD das páginas públicas). Freelance e contrato de IA e dados; filtra por classe. Ver "Classificação" |
| `agentic-jobs` | Desligado. Provider existente (vagas de engenharia de agentes), mas a API do site respondeu HTTP 500 em 05/10/2026 |
| `torre` | **Desligado.** Em 05/10/2026 `search.torre.co` responde HTTP 400 a qualquer corpo, mesmo `{}`. Retestar |
| `remoteok` | Desligado. Os termos pedem link de volta ao remoteok.com |
| `jobspresso` | Desligado. Curado, volume baixo |

## Descoberta de boards (fase 2)

Em vez de ler HTML dos dois sites da fase 2, usei as listas do GitHub do `rn-PORTALS.txt` como fonte para achar boards que **oferecem feed e permitem leitura**. Método (05/10/2026, só leitura):

1. Extraí os domínios de `awesome-job-boards`, `remote-job-sites`, `remote-jobs-list`, `freehire` e `backend-br/vagas`: **639 domínios** (fora redes sociais, ferramentas de currículo e os já cobertos).
2. Sondei cada um (página inicial + `robots.txt`): 495 responderam, 83 declaram RSS/Atom.
3. Li os 78 feeds ainda não cobertos e passei cada vaga pelos **mesmos filtros** do catálogo (título + região). Rendimento, não promessa.

Resultado: **2 boards valem provider**, ambos com termos que permitem a leitura.

| Board | Fonte | Rendimento no teste |
|---|---|---|
| RemoteYeah | RSS oficial (listado no rodapé; `robots.txt` livre; termos sem cláusula de automação) | 30 passam no título, 5 elegíveis, 3 `loc?`, 22 rejeitadas por região. Vagas reais para o Brasil (Commure, Ubiminds, Airtm) |
| TryRemotely | API JSON oficial, sem chave, 100 req/min; atribuição obrigatória (cumprida: toda linha aponta para a vaga no site) | Poucas por rodada, mas com `locations` estruturado |

Os outros 76 feeds ficaram de fora: blogs de carreira (Collibra, careerday, aiapplyd), boards sem região no feed (tudo viraria `loc?`: jobsbylevel, pyjobs, typescriptjobs) ou centrados em EUA/Europa (aidevboard: 17 de 19 rejeitadas).

## Classificação

Todo posting passa por `lib/job-class.mjs` (puro, sem rede, heurística de título) e a etiqueta vai no `note:` da linha da fila: `remote-latam:<fonte> <engajamento>/<domínio> [pagamento] [loc?]`, por exemplo `remote-latam:aigigjobs freelance/ai-ml-eng $60-150/h`. A etiqueta aparece em **todas** as fontes; só quem declara `classes:` no catálogo filtra por ela.

| Eixo | Valores |
|---|---|
| Engajamento | `employee` (FULL_TIME), `contract`, `freelance-gig` (plataforma ou "Freelance"), `crowd-task` (rotulagem, transcrição), `expert-panel` (PhD, advogado, médico), `unknown` (a fonte não informa; **nunca** chutado como emprego) |
| Domínio (primeiro que casa) | `governance`, `data-ai-mgmt`, `ai-eval`, `ai-ml-eng`, `data-science`, `data-eng`, `data-analytics`, `ai-training-ops`, `software-eng`, `non-tech` |
| Pagamento | normalizado para US$/hora. Valor "por hora" acima de 1000 é lido como anual (÷ 2080): o AIGigJobs publica "200000 por HORA" para um salário anual. Faixa: `high` ≥ 100, `mid` ≥ 50, `entry` abaixo |

`governance` e `data-ai-mgmt` espelham os arquétipos B e C do perfil; sem eles, "Head of Data & AI" cairia em `non-tech`. `FULL_TIME` numa plataforma é emprego, não gig: o tipo é lido antes da organização.

No catálogo, `classes:` (e opcionalmente `engagements:`) **substitui** o filtro de título daquela fonte: a vaga fica quando o domínio está em `classes` e o engajamento em `engagements`. Valores desconhecidos derrubam a leitura do catálogo com o nome do erro. O funil conta o que sai por aí em `class` (`dropped_class` no log). Na amostra de 05/10/2026 (94 vagas, 12 páginas) o recorte `[ai-ml-eng, ai-eval, data-science, data-eng, data-analytics]` deixa 33; depois do filtro de região sobram **3** (a maioria dos gigs de IA exige residência nos EUA), então espere poucas linhas por rodada. Um gig com cidade dos EUA no lugar de país ("San Francisco, California") passa como `loc?`: o filtro de região só reconhece países.

Limites: título decide, então "AI Task Auditor" e "Competitive Evaluations" ficam na fronteira de `ai-eval`; o catálogo é o botão de ajuste. O pagamento por hora em US$ não é comparável ao salário anual do perfil sem conversão, por isso fica só na nota. Como avaliar uma vaga freelance no `/career-ops pipeline` (conversão hora → ano) é decisão em aberto.

## Limites conhecidos

- **Volume baixo:** a maioria dos boards publica pouco em IA. Numa rodada de 7 dias, ~10 linhas é o normal.
- **TryRemotely não tem filtro no servidor** e publica ~1.300 vagas por dia de todas as áreas. Para cobrir a janela de 3 dias o scanner lê até 40 páginas de 100 vagas (~255 KB cada, ~1 min no total), e para quando uma página já é mais antiga que a janela. `max_pages: 50` no catálogo cobre ~3,9 dias; se o aviso "truncated at max_pages" aparecer, rode com mais frequência.
- **Sem data** no Remotive e no Working Nomads (o provider não mapeia a data de publicação): o `--since` não filtra essas duas.
- **Hacker News:** o provider às vezes traz `hackernews` como nome da empresa; e a região vem dentro do título, então depende do filtro de texto.
- **Título estrito de propósito.** O `include` do template exige termo de IA/ML/agent/governança, ou "data" junto de uma palavra de liderança. O filtro antigo do `import-config.sh` era mais amplo e puxava "Customer Service Agent" e "Data Centers (Texas)".

## Como adicionar uma fonte

1. Confirme que é gratuita, pública e tem feed (`curl -I` na URL do feed e leitura do `robots.txt`).
2. Se já existe provider em `providers/`, adicione uma entrada em `sources:` do seu `remote-latam.yml`.
3. Se não existe, crie `providers/<id>.mjs` seguindo `providers/ADDING_A_PROVIDER.md` (modelo de RSS: `providers/weworkremotely.mjs`) e um teste em `tests/providers/`.

## Testes

```bash
node test-all.mjs --only remote-latam      # filtro de região + runner, sem rede
node test-all.mjs --only job-class         # classificação de dados e IA
node test-all.mjs --only aigigjobs         # provider do AIGigJobs
```
