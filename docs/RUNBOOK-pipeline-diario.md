# Runbook: pipeline de busca de vagas (career-ops)

Atualizado em 25/09/2026 · mantido pelo dono do fork

Rotina do dia a dia para achar, avaliar e aplicar em vagas. Onde algo **ainda não foi testado
ao vivo**, está marcado (seção 11 tem o status de cada item).

> **Regra de ouro:** scraping é grátis e pode ser frequente; avaliação (`/career-ops pipeline`)
> gasta token e roda por lote. O sistema **nunca envia candidatura sozinho**: ele preenche,
> você revisa e clica em Submit. `Applied` só depois de você enviar de verdade.

---

## 1. Visão geral

Três fontes de vagas alimentam uma fila única, com dois ritmos de automação:

- **Gupy** (sem restrição de ToS declarada): cron diário, junto com os portais do `scan.mjs`.
- **LinkedIn e Vagas.com** (uso pessoal restrito pelos próprios projetos): rodadas manuais.
- **career-ops:** sistema de registro único. Tracker, scoring A-H, geração de CV e carta. Todas
  as fontes convergem para `data/pipeline.md`.

## 2. Fluxo de dados

```
 CRON 07:00  scripts/run-daily-scan.sh                                   (0 tokens)
   ┌─ 1. Gupy CLI ──► import-jobs.mjs ──► descarta > JOBAGE dias ──► filtros de título/cidade
   │                        ──► dedup (URL + empresa+cargo) ──► --verify (vaga viva?) ──┐
   ├─ 2. node scan.mjs --verify --since JOBAGE   (portais do portals.yml, verifica só   ├─► data/pipeline.md
   │        as vagas que ele mesmo acha)  ─────────────────────────────────────────────┤   (mais nova no topo)
   └─ 3. import-jobs.mjs --sort-only   (o scan anexa no fim; reordena)  ───────────────┘

 MANUAL      scripts/run-manual-scan.sh  =  LinkedIn CLI + Vagas.com CLI ──► import-jobs.mjs (mesmo funil)

 AVALIAÇÃO (gasta tokens)
   /career-ops pipeline --fresh-only ──► só vagas com < 2 dias      (diário, rápido)
   /career-ops pipeline              ──► backlog                     (2-3x/semana)
        └─► /career-ops pdf ──► /career-ops apply ──► candidatura manual (você clica Submit)
```

> O `node scan.mjs --verify` **não** é etapa posterior ao import: cada um verifica a própria
> coleta. O import tem `--verify` próprio para as vagas da Gupy.

---

## 3. Cadência por componente

| Componente | Frequência | Custo | Quem roda |
|---|---|---|---|
| Scan Gupy (`--jobage 3`) | Diário, 07:00 | 0 token | Cron |
| `node scan.mjs --verify --since 3` | Junto com o scan diário | 0 token | Cron (mesmo script) |
| Scan LinkedIn / Vagas.com | 2-3x/semana | 0 token | Manual |
| Pass `--fresh-only` (< 2 dias) | Diário, rápido | Token (menor) | Manual (sem agendamento) |
| `/career-ops pipeline` (backlog) | 2-3x/semana, ou ao acumular 15-25 vagas novas | Token | Manual |
| `/career-ops patterns` | A cada 20-30 avaliações novas, ou semanal | Token | Manual |
| `/career-ops upskill` | Quinzenal/mensal, ou quando `patterns` apontar gap recorrente | Token (maior, faz busca web) | Manual |
| `/career-ops discover` | Só ao adicionar empresa nova ao `portals.yml` | Token | Manual, pontual |

---

## 4. Setup do cron (uma vez)

Neste WSL2 o daemon do cron não sobe sozinho. Os comandos assumem o repo em `~/career-ops`; ajuste se estiver em outro lugar.

- [ ] **Subir o daemon:** `sudo service cron start`
- [ ] **Instalar a linha das 07:00** (não sobrescreve o crontab existente):
  ```bash
  (crontab -l 2>/dev/null; echo '0 7 * * * $HOME/career-ops/scripts/run-daily-scan.sh >> $HOME/career-ops/logs/daily-scan.log 2>&1') | crontab -
  crontab -l && service cron status
  ```
- [ ] **Persistir entre boots:** em `/etc/wsl.conf`, `[boot] command` (hoje `ntpdate pool.ntp.org`)
  precisa incluir `service cron start`; depois `wsl --shutdown` no PowerShell.
- [ ] **Chromium do Playwright** (o `--verify` precisa): `npx playwright install chromium`
  (já existe uma instalação em `~/.cache/ms-playwright`).
- [ ] **Teste sem gravar** (~1,5 min, ambiente mínimo como o do cron):
  ```bash
  cd $HOME/career-ops
  env -i HOME=$HOME PATH=/usr/bin:/bin DRY_RUN=1 scripts/run-daily-scan.sh 2>&1 | tail -25
  ```
  Esperado no fim: `daily-scan done (import=0 scan=0 sort=0)`.

> **Limitação do WSL2:** sem terminal aberto o WSL pode estar desligado às 07:00 e o cron não
> dispara. Alternativa robusta: Agendador de Tarefas do Windows, diário às 07:00:
> `wsl.exe -d <distro> -u <usuario> -- bash -lc "$HOME/career-ops/scripts/run-daily-scan.sh >> $HOME/career-ops/logs/daily-scan.log 2>&1"`
> A janela de 3 dias cobre até 2 dias perdidos sem perder vaga.
> **Não testado ao vivo:** o disparo real do cron às 07:00.

### O que o `run-daily-scan.sh` roda

1. `import-jobs.mjs --source gupy --pages 3 --remote remote,hybrid,onsite --jobage 3 --verify`
   com filtro de cidade (São Paulo) e de títulos.
2. `node scan.mjs --verify --throttle --since 3`
3. `import-jobs.mjs --sort-only`

`flock` impede duas execuções sobrepostas. `DRY_RUN=1` roda tudo sem gravar. Os passos são
independentes e o script sai com erro se algum falhar.

---

## 5. Rotina manual: LinkedIn e Vagas.com

Não entram em cron. O LinkedIn porque acesso automatizado contraria os Termos de Serviço; a
Vagas.com porque o `robots.txt` bloqueia nominalmente crawlers da Anthropic. Ambos os projetos
avisam "uso pessoal, volume baixo". Automação diária aumenta o risco de bloqueio de IP sem
ganho proporcional.

```bash
scripts/run-manual-scan.sh --dry-run      # só o funil, não grava
scripts/run-manual-scan.sh                # LinkedIn + Vagas.com (~42 requisições, ~1 min)
JOBAGE=4 scripts/run-manual-scan.sh       # janela de 4 dias, só para esta rodada
```

Rode 2-3x por semana. A janela padrão é 3 dias: se o intervalo entre duas rodadas for maior
(ex.: sexta → terça), use `JOBAGE=4` (ou mais) para não perder o que saiu no meio.
**A janela é a variável `JOBAGE`, não a flag `--jobage`**: passar `--jobage` ao script dá erro
de flag repetida.

---

## 6. Filtros de freshness (< 3 dias)

- **Na fonte:** os três CLIs aceitam `--jobage`. O import **não usa** a flag dos CLIs: Gupy e
  Vagas.com aplicam depois de fatiar a página (uma página curta encerraria a paginação cedo),
  e o LinkedIn só a aceita no servidor.
- **No import:** `import-jobs.mjs --jobage N` **descarta** (não só deduplica) o que passou de N
  dias, em dias corridos, antes de escrever em `data/pipeline.md`. **Vaga sem data é mantida**
  e contada. Cada rodada registra a contagem em `logs/import-age.tsv`.
- **Valor único:** `JOBAGE` (padrão 3) em `scripts/import-config.sh`. Vale para o import
  (`--jobage`) e para o `scan.mjs` (`--since`).
- **Ordenação:** a fila fica por `posted:` decrescente (mais nova no topo). URL colada à mão
  fica no topo; sem data, no fim.
- **Pass `--fresh-only`:** modo separado do `/career-ops pipeline` que avalia só entradas com
  menos de 2 dias (postadas hoje ou ontem). O backlog segue na cadência normal.

---

## 7. Rotina diária (5-15 min)

**7.1 Conferir a coleta (30 s)**
```bash
tail -30 logs/daily-scan.log          # terminou com "done (import=0 scan=0 sort=0)"?
node scripts/fresh-pending.mjs        # quantas frescas (hoje/ontem) na fila
```

**7.2 Avaliar as frescas** (numa sessão do Claude Code neste repo)
```
/career-ops pipeline --fresh-only
```
Liveness só nas frescas → pre-screen barato → avaliação completa das que passam → relatório em
`reports/` → tracker → move para `## Processed`. Não toca no resto da fila. Fecha com a tabela
de scores e uma linha com o backlog que ficou para o pass normal.
Na primeira vez, `node scripts/fresh-pending.mjs --days 1` (só as de hoje) para gastar pouco.

**7.3 Decidir e aplicar**

| Score | Ação |
|---|---|
| **≥ 4.0** | Vale aplicar. `/career-ops apply` (preenche no Chrome; você revisa e envia) |
| **3.0 a 3.9** | Só com motivo específico; leia "Gaps" do relatório antes |
| **< 3.0** | Não aplicar (o sistema desaconselha) |

Depois de **enviar de verdade**:
```bash
node set-status.mjs <nº do relatório> Applied --on AAAA-MM-DD   # data real do envio
node followup-seed.mjs <nº> --date AAAA-MM-DD                   # agenda o 1º follow-up
```
Use `--row N` quando o número da linha do tracker for diferente do relatório (o comando avisa).
Para desistir: `node set-status.mjs <nº> SKIP`.

---

## 8. Quando rodar `discover`, `patterns` e `upskill`

Os três são disparados por **gatilho**, não por agenda fixa.

- **`/career-ops discover`:** só ao adicionar empresa nova ao `portals.yml`, para resolver o
  board ATS real antes de o scan tentar ler.
- **`/career-ops patterns`:** precisa de volume para dizer algo útil. Gatilho: a cada 20-30
  avaliações novas, ou semanalmente, o que vier primeiro (foi assim que apareceu o padrão de
  "confirmar elegibilidade" no lote das 23).
- **`/career-ops upskill`:** faz busca na web e custa mais token. Dois gatilhos: depois que
  `patterns` apontar uma lacuna recorrente, ou numa checagem geral quinzenal/mensal.

---

## 9. Checklist operacional

**Diário (automático + 5 min)**
- [ ] Cron roda scan Gupy (`--jobage 3`) + `scan.mjs --verify --since 3` + ordenação
- [ ] Conferir `logs/daily-scan.log` (e `node scripts/fresh-pending.mjs`)
- [ ] `/career-ops pipeline --fresh-only`

**2-3x/semana (manual)**
- [ ] `scripts/run-manual-scan.sh` (LinkedIn + Vagas.com; `JOBAGE=4` se o intervalo passar de 3 dias)
- [ ] `/career-ops pipeline` sobre o acumulado (veja o tamanho: `grep -c '^- \[ \]' data/pipeline.md`)

**Semanal**
- [ ] `/career-ops patterns` (se ≥ 20-30 novas avaliações)
- [ ] Follow-ups pendentes: `node followup-cadence.mjs`
- [ ] Higiene: `node verify-pipeline.mjs` (0 erros), `node stats.mjs --summary`, `node update-system.mjs check`

**Quinzenal/mensal**
- [ ] `/career-ops upskill`

**Pontual**
- [ ] `/career-ops discover` ao adicionar empresa nova

---

## 10. Referência dos scripts

### `import-jobs.mjs`
```
node scripts/import-jobs.mjs [--source gupy|vagas|linkedin] [--dry-run] [--pages N]
     [--remote remote,hybrid,onsite] [--city "São Paulo"] [--jobage DIAS] [--verify]
     [--keep-anywhere REGEX] [--include REGEX] [--exclude REGEX] "query" ...
node scripts/import-jobs.mjs --sort-only [--dry-run]
```
Normaliza os campos das três fontes (id, título, empresa, local, data, URL) para o mesmo
formato de linha do `scan.mjs`: `- [ ] {url} | {empresa} | {título} | {local} | posted: AAAA-MM-DD | note: {fonte}`.
O funil impresso mostra cada corte:
`resultados → únicos por id → −antigas → −título → −fora da cidade → −repetidas empresa+cargo →
−URL conhecida → −empresa+cargo conhecida → −mortas → novas`.

- **Dedup:** por URL e por **empresa+cargo**, contra fila, histórico de scan e tracker. Isso
  resolve a vaga cross-postada em fontes diferentes e a que você já aplicou por outro ATS.
- **`--verify`:** descarta vaga expirada ou sem botão de aplicar (mesma regra do `scan.mjs`).
  Se o checker não responder, não descarta nada.

### `fresh-pending.mjs`
`node scripts/fresh-pending.mjs [--days 2] [--json] [--urls-file F]`. Só lê. É a fonte de
verdade do que o fresh pass pode tocar.

### Onde ajustar
| Quer mudar | Onde |
|---|---|
| Queries, cidade, filtros de título, `JOBAGE` | `scripts/import-config.sh` |
| Horário do cron | `crontab -e` |
| Janela só numa rodada | `JOBAGE=4 scripts/run-manual-scan.sh` (ou `run-daily-scan.sh`) |
| Regra do fresh pass | `modes/_custom.md` → "fresh pass" (camada de usuário, fora do git) |
| Portais do scan | `portals.yml` |

### Logs e backups (`logs/`, fora do git)
| Arquivo | Conteúdo |
|---|---|
| `daily-scan.log` | Saída completa de cada rodada do cron |
| `import-age.tsv` | Uma linha por import: `timestamp, source, jobage_days, results, unique, dropped_age, undated_kept, new, dry_run` (filtre `dry_run=0` para o volume real) |
| `pipeline.before-*.md` | Cópias do `pipeline.md` antes de limpezas e ordenação |
| `pruned-*.md` | Lista exata do que saiu em cada limpeza |

O `scan.mjs` tem registro próprio em `data/scan-runs.tsv` (`node stats.mjs --summary`).
Restaurar a fila de antes da última limpeza: `cp logs/pipeline.before-prune-old-2026-09-25.md data/pipeline.md`.

### Problemas comuns
| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Log sem a rodada de hoje | Daemon do cron parado ou WSL desligado | `service cron status`; `sudo service cron start`; ver Agendador do Windows (seção 4) |
| `already running, skipping` | Outra execução em andamento (ou travada) | Aguarde; se travou, `pgrep -af run-daily-scan` e encerre |
| `--verify requires Playwright with Chromium` | Chromium ausente | `npx playwright install chromium` |
| `import ... FAILED` em várias queries | CLI da fonte fora do ar ou `bun` fora do PATH | Rode o CLI à mão; o cron usa `import-config.sh` para o PATH |
| `--jobage was given more than once` | Passou `--jobage` ao `run-manual-scan.sh` | `JOBAGE=4 scripts/run-manual-scan.sh` |
| Poucas vagas novas por dias | Janela + dedup, ou fonte sem resultados | Veja `logs/import-age.tsv` (`results`, `dropped_age`, `new`) |
| Fila fora de ordem após `node scan.mjs` avulso | O scan anexa no fim | `node scripts/import-jobs.mjs --sort-only` |
| LinkedIn devolve pouco ou 429 | Rate limit | Espere e reduza a frequência; nunca aumente o volume |

---

## 11. Status dos itens que estavam pendentes

Verificados no repositório em 25/09/2026:

- [x] **`--jobage` em LinkedIn e Vagas.com:** os dois CLIs suportam. Vagas.com e Gupy filtram no
  cliente, depois do fetch; o LinkedIn filtra no servidor (`f_TPR`). O import faz o filtro
  manualmente, igual para as três fontes.
- [x] **`scripts/import-jobs.mjs` existe e normaliza** id, título, empresa, local, data e URL
  (a fonte vira o rótulo `note:`). Commitado na branch `feat/job-import-scripts`.
- [x] **`/career-ops pipeline` lê a fila de cima para baixo**, mas por leitura implícita: o modo
  não escreve regra de ordem, e o `rank-pipeline` nunca reordena. A ordenação por data é
  premissa razoável, não garantia.
- [x] **`--fresh-only` implementado** como workflow no `modes/_custom.md` (camada de usuário,
  sobrevive a updates) mais `scripts/fresh-pending.mjs`. **Não testado ao vivo:** a execução
  completa do pass (gasta tokens); só a seleção foi testada.
- [x] **Dedup entre fontes:** deixou de ser limitação. É feito por URL e por empresa+cargo.
  Resta o caso de nomes diferentes para a mesma empresa ou cargo (não deduplica), que é
  resolvido na avaliação.
- [ ] **Disparo real do cron às 07:00:** não testado.
- [ ] **Execução completa do `/career-ops pipeline --fresh-only`:** não testada.

**Risco de ToS:** LinkedIn e Vagas.com Search rodam sob uso pessoal restrito pelos próprios
projetos. Volume baixo e frequência manual reduzem o risco de bloqueio, mas não o eliminam.

## 12. Arquivos-chave

```
scripts/run-daily-scan.sh     cron: Gupy → scan.mjs → ordena
scripts/run-manual-scan.sh    LinkedIn + Vagas.com (manual)
scripts/import-jobs.mjs       import + filtros + ordenação da fila
scripts/import-config.sh      queries, filtros, JOBAGE, PATH do cron
scripts/fresh-pending.mjs     seleção das vagas frescas
modes/_custom.md              regra "fresh pass" (camada de usuário, fora do git)
data/pipeline.md              a fila (mais nova no topo)
data/applications.md          tracker
logs/                         logs e backups (fora do git)
```
