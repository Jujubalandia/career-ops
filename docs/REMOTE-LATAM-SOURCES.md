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

Sem `remote-latam.yml`, o scanner usa o template (avisa no stderr). O wrapper **não está no cron**: rode à mão até confiar no funil.

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
| Sem feed de vagas | aigigjobs.com, remoteleaf.com, remotesource.com, arc.dev | **Fora**. Só HTML ou JSON-LD embutido. O AIGigJobs é legível (10 blocos JSON-LD por página, `robots.txt` permissivo com Crawl-delay de 5 s) mas quase só traz freelance e crowd-work (Mercor, "AI Data Collection Contributor"), sem aderência aos arquétipos |
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
```
