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

- **Aceita:** LATAM, América Latina/do Sul, Americas, Brasil, Worldwide, Anywhere, Global, "Remote (Global)".
- **Rejeita:** "US only", "must be authorized to work in the US", "REMOTE (UK)", fuso CET/EET/GMT, vaga **presencial ou híbrida sem opção remota**, região que exclui o Brasil (EUA, Europa, EMEA, Ásia) e **outro país latino sozinho** ("Argentina", "Mexico").
- **`unknown` (mantida, marcada `loc?`):** sem região no texto, ou "Global (US/CAN/EU/India)", que lista regiões em vez de dizer "mundo".
- Fusos dos EUA **não** são restrição (a sobreposição ET/CT serve ao seu perfil).

## Auditoria do `docs/rn-PORTALS.txt` (35 URLs)

Validada em 05/10/2026 com `curl` (status, `robots.txt`, feeds declarados na página).

| Grupo | URLs | Decisão |
|---|---|---|
| Já têm provider | remotive.com, nodesk.co, workingnomads.com, news.ycombinator.com | **Usadas** (`remotive`, `nodesk`, `workingnomads`, `hackernews`) |
| Espelhos do thread do HN | hnwork.app, nthesis.ai, dheerajck.github.io/hnwhoishiring, nchelluri.github.io/hnjobs, hnjobs.emilburzo.com | **Cobertas** pelo provider `hackernews` (mesma fonte) |
| RSS de vagas, sem provider | fossjobs.net (`/rss/all/`), opensourcejobhub.com (`/rss/`) | **Fora por ora**: boards de open source, pouca vaga de IA/dados; viram provider se você quiser |
| Sem feed de vagas | remoterocketship.com, aigigjobs.com, remoteleaf.com, remotesource.com, arc.dev | **Fora**. Só HTML ou JSON-LD embutido. O Remote Rocketship tem filtro "Latin America", então é o melhor candidato da fase 2 |
| Bloqueado ou com login | startup.jobs (403, `robots.txt` restritivo), ziprecruiter.com, indeed.com | **Fora** |
| Índices do GitHub | awesome-job-boards, remote-jobs (3 listas), remote-job-sites, backend-br/vagas, freehire, awesome-ai-startups-hiring, remoteintech | **Fora por ora**. Não são boards, mas servem para descobrir boards na fase 2 |
| Não são vagas | hiretalent.lat, latojobs.com (cadastro de candidato), arc.dev (onboarding), hireslink (relatório), Cloudflare careers (Lisboa) | **Fora** |

### Boards fora da lista, com provider e sinal LATAM

Entram no catálogo porque já existem, são gratuitos e trazem região:

| Provider | Situação |
|---|---|
| `getonbrd` | Ativo. Board nativo da América Latina (categorias `machine-learning-ai`, `programming`, `operations-management`) |
| `himalayas` | Ativo. Campo `locationRestrictions` separa "worldwide" de restrito |
| `jobicy` | Ativo. Campo `jobGeo` |
| `weworkremotely` | Ativo. RSS, local muitas vezes vazio |
| `torre` | **Desligado.** Em 05/10/2026 `search.torre.co` responde HTTP 400 a qualquer corpo, mesmo `{}`. Retestar |
| `remoteok` | Desligado. Os termos pedem link de volta ao remoteok.com |
| `jobspresso` | Desligado. Curado, volume baixo |

## Limites conhecidos

- **Volume baixo:** a maioria dos boards publica pouco em IA. Numa rodada de 7 dias, ~10 linhas é o normal.
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
