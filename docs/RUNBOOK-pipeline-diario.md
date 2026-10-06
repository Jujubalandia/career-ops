# Runbook: pipeline de busca de vagas (career-ops)

Atualizado em 05/10/2026 · mantido pelo dono do fork

Rotina do dia a dia para achar, avaliar e aplicar em vagas. Onde algo **ainda não foi testado
ao vivo**, está marcado (seção 11 tem o status de cada item).

> **Regra de ouro:** scraping é grátis e pode ser frequente; avaliação (`/career-ops pipeline`)
> gasta token e roda por lote. O sistema **nunca envia candidatura sozinho**: ele preenche,
> você revisa e clica em Submit. `Applied` só depois de você enviar de verdade.

> ✅ **Estado real do cron em 02/10:** o cron **disparou sozinho** às 07:00:01 em 29/09, 30/09 e
> 01/10 (pares `start`/`done` em `logs/daily-scan.log`). Em 02/10 a rodada registrada é das 07:41,
> ou seja, atrasada: o WSL provavelmente só estava de pé depois das 07:00. A persistência no boot
> (`/etc/wsl.conf`) e o Agendador do Windows continuam não configurados; a janela de 3 dias
> (`--jobage 3`) cobre disparos perdidos pontuais. Seção 4 tem o diagnóstico.

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
             (--pages N para ver além da 1ª página — seção 5)

 AVALIAÇÃO (gasta tokens)
   /career-ops pipeline --fresh-only ──► só vagas com < 2 dias      (diário, rápido)
   /career-ops pipeline              ──► backlog inteiro             (2-3x/semana)
   avaliação por recorte             ──► fatia do backlog por rank/critério  (seção 7b)
        └─► /career-ops pdf ──► /career-ops apply ──► candidatura manual (você clica Submit)
```

> O `node scan.mjs --verify` **não** é etapa posterior ao import: cada um verifica a própria
> coleta. O import tem `--verify` próprio para as vagas da Gupy.

---

## 3. Cadência por componente

| Componente | Frequência | Custo | Quem roda |
|---|---|---|---|
| Scan Gupy (`--jobage 3`) | Diário, 07:00 (**ver aviso no topo**) | 0 token | Cron |
| `node scan.mjs --verify --since 3` | Junto com o scan diário | 0 token | Cron (mesmo script) |
| Scan LinkedIn / Vagas.com | 2-3x/semana | 0 token | Manual |
| Scan remoto LATAM (seção 5b) | Diário, 07:20 | 0 token | Cron (linha própria) |
| Pass `--fresh-only` (< 2 dias) | Diário, rápido | Token (menor) | Manual (sem agendamento) |
| `/career-ops pipeline` (backlog) | 2-3x/semana, ou ao acumular 15-25 vagas novas | Token | Manual |
| Avaliação por recorte (seção 7b) | Sob demanda, quando o backlog geral é grande demais para rodar de uma vez | Token | Manual |
| `/career-ops patterns` | A cada 20-30 avaliações novas, ou semanal | Token | Manual |
| `/career-ops upskill` | Quinzenal/mensal, ou quando `patterns` apontar gap recorrente | Token (maior, faz busca web) | Manual |
| `/career-ops discover` | Só ao adicionar empresa nova ao `portals.yml` | Token | Manual, pontual |

---

## 4. Setup do cron (uma vez) + diagnóstico de disparo

Neste WSL2 o daemon do cron não sobe sozinho. Os comandos assumem o repo em `~/career-ops`; ajuste se estiver em outro lugar.

- [x] **Subir o daemon:** `sudo service cron start` — feito, `service cron status` confirma rodando.
- [x] **Instalar a linha das 07:00:** já está em `crontab -l`.
  ```bash
  (crontab -l 2>/dev/null; echo '0 7 * * * $HOME/career-ops/scripts/run-daily-scan.sh >> $HOME/career-ops/logs/daily-scan.log 2>&1') | crontab -
  crontab -l && service cron status
  ```
- [x] **Linha das 07:20 (remote LATAM):** instalada em 05/10, log próprio `logs/remote-latam-cron.log`,
  `flock` próprio. Sem `--verify` por enquanto; ligue depois de ~1 semana de logs limpos.
  ```bash
  (crontab -l; echo '20 7 * * * $HOME/career-ops/scripts/run-remote-latam-scan.sh >> $HOME/career-ops/logs/remote-latam-cron.log 2>&1') | crontab -
  ```
- [x] **Persistir entre boots:** `/etc/wsl.conf` já tem `[boot] command = "ntpdate pool.ntp.org; service cron start"`
  (conferido em 05/10). Mudar exige `sudo` e `wsl --shutdown` no PowerShell.
- [x] **Chromium do Playwright** (o `--verify` precisa): já instalado em `~/.cache/ms-playwright`.
- [x] **Teste sem gravar** (~1,5 min, ambiente mínimo como o do cron):
  ```bash
  cd $HOME/career-ops
  env -i HOME=$HOME PATH=/usr/bin:/bin DRY_RUN=1 scripts/run-daily-scan.sh 2>&1 | tail -25
  ```
  Esperado no fim: `daily-scan done (import=0 scan=0 sort=0)`. **Já rodou com sucesso.**

### Diagnóstico: o cron disparou sozinho hoje?

Rode isto pela manhã, depois das 07:00, para confirmar (não confie de memória — já aconteceu de eu
ler a data errada de uma linha de log e achar que tinha rodado quando não tinha):

```bash
grep '=== ' logs/daily-scan.log logs/remote-latam-cron.log | tail -6      # toda "start"/"done" registrada, com timestamp
crontab -l                                      # a linha ainda está lá?
service cron status                             # o daemon ainda está de pé?
```

Se a última linha `start` não for de hoje por volta das 07:00, **o cron não disparou** — o daemon
rodando e a linha no crontab não garantem o disparo (motivo provável: WSL suspenso/desligado às
07:00, ou o daemon caiu depois de um `wsl --shutdown`/reinício sem persistência configurada).

> **Estado em 02/10:** o cron disparou sozinho às 07:00:01 em 29/09, 30/09 e 01/10. Em 02/10 a
> rodada foi às 07:41 (WSL atrasado). Se a última linha `start` não for de ~07:00, rode
> `scripts/run-daily-scan.sh` manualmente, ou migre para a alternativa do Agendador do Windows abaixo.

> **Limitação do WSL2:** sem terminal aberto o WSL pode estar desligado às 07:00 e o cron não
> dispara. Alternativa mais robusta, que **acorda o WSL sozinha** (não depende do daemon do cron):
> Agendador de Tarefas do Windows, diário às 07:00:
> ```bash
> schtasks.exe /Create /TN "career-ops daily scan" /SC DAILY /ST 07:00 /F /TR "wsl.exe -d <distro> -u <usuario> -- bash -lc '$HOME/career-ops/scripts/run-daily-scan.sh >> $HOME/career-ops/logs/daily-scan.log 2>&1'"
> schtasks.exe /Query /TN "career-ops daily scan" /V /FO LIST | grep -E "Last Run|Last Result"
> ```
> `Last Result: 0` confirma sucesso. Ainda não configurado neste ambiente.
> A janela de 3 dias (`--jobage 3`) cobre até 2 dias perdidos sem perder vaga, então um disparo
> perdido ocasionalmente não é grave — mas vários dias seguidos sem disparo, sim.

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
scripts/run-manual-scan.sh --dry-run           # só o funil, não grava
scripts/run-manual-scan.sh                     # LinkedIn + Vagas.com, --pages 1 (padrão do script)
JOBAGE=4 scripts/run-manual-scan.sh            # janela de 4 dias, só para esta rodada
JOBAGE=4 scripts/run-manual-scan.sh --pages 2  # janela maior + 2ª página (ver diagnóstico abaixo)
```

Rode 2-3x por semana. A janela padrão é 3 dias: se o intervalo entre duas rodadas for maior
(ex.: sexta → segunda à tarde), use `JOBAGE=4` (ou mais) para não perder o que saiu no meio.
**A janela é a variável `JOBAGE`, não a flag `--jobage`**: passar `--jobage` ao script dá erro
de flag repetida. `--pages` (e qualquer outra flag) passa direto para as duas fontes, porque o
script repassa `"$@"`.

### Diagnóstico: estou batendo no teto de página?

`scripts/run-manual-scan.sh` roda com `--pages 1` por padrão — 1 página por query por fonte.
LinkedIn devolve no máximo 10 resultados por página; se **todas** as combinações
query×modo baterem exatamente nesse teto, o total de `results` bate certinho com
`nº de queries × nº de modos × 10`, e isso é sinal de que a página 2 tem mais vaga que você
não está vendo — não que acabaram as vagas.

```bash
tail -3 logs/import-age.tsv                       # results/unique/new da última rodada
```
Com 20 queries e 2 modos (`remote,hybrid`), `results = 400` no LinkedIn = 40×10 = teto batido em
100% das combinações (confirmado em 3 rodadas seguidas em 25-27/09). Quando isso acontecer,
`--pages 2` (ou mais) numa rodada pontual é a forma de ver o que está além da 1ª página — ao
custo de dobrar as requisições àquela fonte. Nunca torne isso o padrão automático sem decidir
isso de propósito (ver "Regra de ouro" e o aviso de ToS acima).

---

## 5b. Fontes remotas LATAM (cron 07:20 + manual)

Boards remotos gratuitos com feed ou API (Remotive, Get on Board, Hacker News "Who is hiring?", Working Nomads, Himalayas, Jobicy, We Work Remotely, NoDesk) alimentam a mesma fila, sem passar pelo Gupy nem pelo `scan.mjs`. Catálogo em `remote-latam.yml` (copie de `templates/remote-latam.example.yml`).

```bash
scripts/run-remote-latam-scan.sh --dry-run     # funil por fonte, não grava
scripts/run-remote-latam-scan.sh               # grava as novas (janela: JOBAGE, padrão 3)
```

Cada linha leva `note: remote-latam:<fonte>`, e `loc?` quando o board não diz a região (confira no pre-screen). O volume é baixo (~10 linhas por rodada de 7 dias é o normal). A nota também traz a classe do trabalho (`freelance/ai-ml-eng $60-150/h`, `employee/governance`...); a fonte `aigigjobs` (freelance de IA e dados, ~1 min por rodada) filtra por classe em vez de título. Detalhes, regras de região e auditoria das fontes: `docs/REMOTE-LATAM-SOURCES.md`. Roda no cron às 07:20 (linha própria, seção 4), **não** dentro do `run-daily-scan.sh`: lock e log separados. Os comandos acima servem para rodar à mão (cenários B e C da seção 13).

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
grep '=== ' logs/daily-scan.log | tail -4       # o cron (ou você) rodou hoje? (ver seção 4)
node scripts/fresh-pending.mjs                  # quantas frescas (hoje/ontem) na fila
```

**7.2 Avaliar as frescas** (numa sessão do Claude Code neste repo)
```
/career-ops pipeline --fresh-only
```
Liveness só nas frescas → pre-screen barato → avaliação completa das que passam → relatório em
`reports/` → tracker → move para `## Processed`. Não toca no resto da fila. Fecha com a tabela
de scores e uma linha com o backlog que ficou para o pass normal. **Testado ao vivo** (27/09,
7 vagas frescas: 4 descartadas no pre-screen, 3 avaliadas por completo).
Na primeira vez, `node scripts/fresh-pending.mjs --days 1` (só as de hoje) para gastar pouco.

**7.3 Decidir e aplicar**

| Score | Ação |
|---|---|
| **≥ 4.0** | Vale aplicar. `/career-ops apply` (preenche no Chrome; você revisa e envia) |
| **3.0 a 3.9** | Só com motivo específico; leia "Gaps" do relatório antes |
| **< 3.0** | Não aplicar (o sistema desaconselha) — nessa faixa o PDF nem é gerado por padrão |

Depois de **enviar de verdade**:
```bash
node set-status.mjs <nº do relatório> Applied --on AAAA-MM-DD   # data real do envio
node followup-seed.mjs <nº> --date AAAA-MM-DD                   # agenda o 1º follow-up
```
Use `--row N` quando o número da linha do tracker for diferente do relatório (o comando avisa).
Para desistir: `node set-status.mjs <nº> SKIP`.

---

## 7b. Avaliação por recorte do backlog (quando "tudo de uma vez" é grande demais)

O `/career-ops pipeline` sem `--fresh-only` processa a fila **inteira** — no backlog atual isso é
mais de 100 vagas, várias horas de trabalho. Quando você quer avaliar só uma fatia (por exemplo,
"só as com `rank:` ≥ 4.0", ou "só as sem o padrão pré-vendas"), o fluxo é manual, mas usa os
mesmos scripts zero-token do pipeline automático. Passo a passo (feito ao vivo em 27/09 com um
recorte de 33 vagas):

1. **Filtrar as URLs do recorte** direto de `data/pipeline.md` (por `rank:`, empresa, padrão de
   título etc. — não existe flag pronta para isso, é um script de uma linha por critério).
2. **Liveness sweep só nessa lista**, não na fila inteira:
   ```bash
   node check-liveness.mjs --file <arquivo-com-as-urls.txt> --throttle
   ```
3. **Pre-screen rápido de cada sobrevivente** com `fetch-jd.mjs` antes de decidir se vale a pena
   uma avaliação completa — muito mais rápido que abrir o Chrome/Playwright quando o board é
   Greenhouse ou Ashby (a maioria):
   ```bash
   node fetch-jd.mjs "<url>"      # texto da vaga direto da API do ATS, sem browser
   ```
   Se o board não é um ATS conhecido (`exit 1`, saída vazia), aí sim cai para Playwright.
4. **Descartar com motivo, registrado** (mesmo padrão do pre-screen automático):
   ```bash
   # anexa em data/discard.log: timestamp, url, motivo
   ```
   e mover a linha de `## Pending` para `## Processed` como `skipped (pre-screen mismatch: ...)`.
5. **Avaliação completa só das sobreviventes**, reservando os números de relatório de uma vez:
   ```bash
   node reserve-report-num.mjs --count N
   ```
6. **Antes de escrever cada relatório**, `node company-history.mjs --company "X" --summary`
   confirma se já existe histórico (relatórios anteriores, reposts) — evita reavaliar do zero
   um padrão de mismatch já provado (ex.: uma empresa cujos títulos "Applied AI Architect" já
   pontuaram baixo 5 vezes).
7. `node merge-tracker.mjs` no fim, uma vez para todo o lote.

**Calibração útil antes de escolher o recorte:** olhe quantas das vagas do recorte são de
empresas que **já têm relatório completo** aqui — a nota real delas no passado é o melhor
indicador de como o recorte vai se sair, muito melhor que o `rank:` sozinho (que não pega
função pré-vendas nem stack específico). Rodando isso em 27/09, das 55 vagas com `rank:` ≥ 4.0,
24 eram de 8 empresas com histórico aqui, e **nenhuma delas nunca passou de 3.4** apesar do
`rank:` alto.

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

**Diário**
- [ ] Confirmar que o cron rodou de verdade: `grep '=== ' logs/daily-scan.log logs/remote-latam-cron.log | tail -6` (ver
      aviso no topo — hoje isso ainda precisa de checagem manual, não é garantido)
- [ ] `node scripts/fresh-pending.mjs`
- [ ] `/career-ops pipeline --fresh-only`

**2-3x/semana (manual)**
- [ ] `scripts/run-manual-scan.sh` (LinkedIn + Vagas.com; `JOBAGE=4` se o intervalo passar de 3
      dias; `--pages 2` de vez em quando se `tail -3 logs/import-age.tsv` mostrar teto batido)
- [ ] `/career-ops pipeline` sobre o acumulado, ou a avaliação por recorte (seção 7b) se o
      backlog estiver grande demais para rodar de uma vez

**Semanal**
- [ ] `/career-ops patterns` (se ≥ 20-30 novas avaliações)
- [ ] Follow-ups pendentes: `node followup-cadence.mjs`
- [ ] Higiene: `node verify-pipeline.mjs` (0 erros), `node check-jd-archive.mjs --summary`,
      `node stats.mjs --summary`, `node update-system.mjs check`

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

- **`--pages N`:** páginas por query por fonte. Padrão 1 no manual, 3 no diário (Gupy). Só busca
  a próxima página se a atual veio cheia (teto da fonte) — então aumentar isso só importa quando
  o funil já está batendo no teto (seção 5, diagnóstico).
- **Dedup:** por URL e por **empresa+cargo**, contra fila, histórico de scan e tracker. Isso
  resolve a vaga cross-postada em fontes diferentes e a que você já aplicou por outro ATS.
- **`--verify`:** descarta vaga expirada ou sem botão de aplicar (mesma regra do `scan.mjs`).
  Se o checker não responder, não descarta nada.

### `fresh-pending.mjs`
`node scripts/fresh-pending.mjs [--days 2] [--json] [--urls-file F]`. Só lê. É a fonte de
verdade do que o fresh pass pode tocar. `--urls-file` grava a lista pronta para
`check-liveness.mjs --file`.

### `fetch-jd.mjs` (atalho de pre-screen, sem browser)
`node fetch-jd.mjs <url>`. Puxa o texto da vaga direto da API pública do ATS (Greenhouse, Lever,
Ashby, Workday), sem precisar do Chrome/Playwright. Exit 0 e o texto no stdout quando o board é
suportado; exit 1 e saída vazia quando não é — nesse caso, cai para Playwright/WebFetch como já
previsto no `modes/pipeline.md`. Muito mais rápido para descartar vaga óbvia (localização,
função) antes de decidir se vale uma avaliação completa.

### `check-liveness.mjs`
`node check-liveness.mjs --file <lista.txt> [--throttle] [--no-fallback]`. Zero tokens
(API do ATS primeiro, Playwright só se precisar). Usado tanto pelo fresh pass quanto por
qualquer recorte manual do backlog (seção 7b).

### `company-history.mjs`
`node company-history.mjs --company "Nome" --summary`. Read-only: mostra se já existe histórico
de candidatura/relatório para a empresa e se há sinal de reposting. Útil antes de avaliar uma
vaga nova de uma empresa que você já viu — a nota real de relatórios anteriores prevê melhor que
o `rank:` (seção 7b tem o exemplo).

### `reserve-report-num.mjs`
`node reserve-report-num.mjs --count N` reserva um bloco de números sequenciais antes de um lote
de avaliações (evita colisão se mais de um processo estiver reservando ao mesmo tempo).
`--release INÍCIO-FIM` libera o que não foi usado.

### Onde ajustar
| Quer mudar | Onde |
|---|---|
| Queries, cidade, filtros de título, `JOBAGE` | `scripts/import-config.sh` |
| Horário do cron | `crontab -e` |
| Janela ou páginas só numa rodada | `JOBAGE=4 scripts/run-manual-scan.sh --pages 2` (ou `run-daily-scan.sh`) |
| Regra do fresh pass | `modes/_custom.md` → "fresh pass" (camada de usuário, fora do git) |
| Portais do scan | `portals.yml` |

### Logs e backups (`logs/`, fora do git)
| Arquivo | Conteúdo |
|---|---|
| `daily-scan.log` | Saída completa de cada rodada do cron. Cada rodada tem um par `=== ... start ===` / `=== ... done ===` com timestamp — é a prova de que o cron disparou, não uma suposição |
| `import-age.tsv` | Uma linha por import: `timestamp, source, jobage_days, results, unique, dropped_age, undated_kept, new, dry_run` (filtre `dry_run=0` para o volume real; `results` vs. queries×modos×10 detecta teto de página — seção 5) |
| `pipeline.before-*.md` | Cópias do `pipeline.md` antes de limpezas e ordenação |
| `pruned-*.md` | Lista exata do que saiu em cada limpeza |

`data/discard.log` (não é `logs/`, fica no git) registra cada vaga descartada no pre-screen
(automático ou manual): `timestamp \t url \t motivo`.

O `scan.mjs` tem registro próprio em `data/scan-runs.tsv` (`node stats.mjs --summary`).
Restaurar a fila de antes da última limpeza: `cp logs/pipeline.before-prune-old-2026-09-25.md data/pipeline.md`.

### Problemas comuns
| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `grep '=== ' logs/daily-scan.log` não mostra rodada de hoje | Cron não disparou (ver aviso no topo — estado conhecido em 28/09) | Rode `scripts/run-daily-scan.sh` manualmente; considere o Agendador do Windows (seção 4) |
| `already running, skipping` | Outra execução em andamento (ou travada) | Aguarde; se travou, `pgrep -af run-daily-scan` e encerre |
| `--verify requires Playwright with Chromium` | Chromium ausente | `npx playwright install chromium` |
| `import ... FAILED` em várias queries | CLI da fonte fora do ar ou `bun` fora do PATH | Rode o CLI à mão; o cron usa `import-config.sh` para o PATH |
| `--jobage was given more than once` | Passou `--jobage` ao `run-manual-scan.sh` | `JOBAGE=4 scripts/run-manual-scan.sh` |
| Poucas vagas novas, `results` = queries×modos×10 exato | Teto de página (1ª página cheia toda vez) | `--pages 2` numa rodada pontual (seção 5) |
| Poucas vagas novas, `results` normal (não bate no teto) | Janela/dedup fazendo o trabalho, ou fonte genuinamente sem mais resultados | Não é bug — é o funil funcionando; considere ampliar `JOBAGE` ou trocar queries fracas |
| Fila fora de ordem após `node scan.mjs` avulso | O scan anexa no fim | `node scripts/import-jobs.mjs --sort-only` |
| LinkedIn devolve pouco ou 429 | Rate limit | Espere e reduza a frequência; nunca aumente o volume |

---

## 11. Status dos itens que estavam pendentes

Verificados no repositório, atualizado em 28/09/2026:

- [x] **`--jobage` em LinkedIn e Vagas.com:** os dois CLIs suportam. Vagas.com e Gupy filtram no
  cliente, depois do fetch; o LinkedIn filtra no servidor (`f_TPR`). O import faz o filtro
  manualmente, igual para as três fontes.
- [x] **`scripts/import-jobs.mjs` existe e normaliza** id, título, empresa, local, data e URL
  (a fonte vira o rótulo `note:`). Commitado na branch `feat/job-import-scripts`.
- [x] **`/career-ops pipeline` lê a fila de cima para baixo**, mas por leitura implícita: o modo
  não escreve regra de ordem, e o `rank-pipeline` nunca reordena. A ordenação por data é
  premissa razoável, não garantia.
- [x] **`--fresh-only` implementado e testado ao vivo** (27/09): 7 vagas frescas, liveness sweep,
  pre-screen (4 descartadas com motivo em `data/discard.log`), 3 avaliações completas com
  relatório + PDF + tracker, backlog intacto.
- [x] **Dedup entre fontes:** feito por URL e por empresa+cargo. Resta o caso de nomes diferentes
  para a mesma empresa ou cargo (não deduplica), resolvido na avaliação.
- [x] **Avaliação por recorte do backlog testada ao vivo** (27/09): 33 vagas filtradas por
  `rank:` ≥ 4.0 sem padrão pré-vendas → liveness sweep → pre-screen com `fetch-jd.mjs` → 18
  descartadas, 5 avaliadas por completo. Ver seção 7b para o passo a passo.
- [x] **Disparo real do cron às 07:00: confirmado em 02/10.** Rodadas automáticas às 07:00:01 em
  29/09, 30/09 e 01/10 (`grep '=== ' logs/daily-scan.log`). Em 02/10 só às 07:41 (WSL atrasado).
  A confirmação anterior de 25/09 estava errada (leitura errada da data de uma linha de log); esta
  vem dos timestamps dos pares `start`/`done`. Ver aviso no topo e seção 4.
- [ ] **Agendador de Tarefas do Windows como alternativa ao cron:** documentado, não configurado.
- [x] **`/etc/wsl.conf` com `service cron start` no boot:** já configurado (conferido 05/10).
- [x] **Remote LATAM no cron (07:20):** instalado em 05/10; confirmar o 1º disparo em 06/10.

**Risco de ToS:** LinkedIn e Vagas.com Search rodam sob uso pessoal restrito pelos próprios
projetos. Volume baixo e frequência manual reduzem o risco de bloqueio, mas não o eliminam.
`--pages` acima de 1 dobra (ou mais) as requisições — use pontualmente, não como padrão, sem
decidir isso de propósito.

## 12. Arquivos-chave

```
scripts/run-daily-scan.sh     cron: Gupy → scan.mjs → ordena
scripts/run-manual-scan.sh    LinkedIn + Vagas.com (manual)
scripts/run-remote-latam-scan.sh  boards remotos LATAM → fila (cron 07:20, seção 5b)
scripts/scan-remote-latam.mjs funil dos boards remotos (catálogo remote-latam.yml)
lib/latam-eligibility.mjs     filtro de região (LATAM / Brasil / worldwide)
scripts/import-jobs.mjs       import + filtros + ordenação da fila
scripts/import-config.sh      queries, filtros, JOBAGE, PATH do cron
scripts/fresh-pending.mjs     seleção das vagas frescas
fetch-jd.mjs                  JD via API do ATS, sem browser (pre-screen rápido)
check-liveness.mjs            liveness zero-token (fresh pass e recortes manuais)
company-history.mjs           histórico/reposting por empresa (read-only)
reserve-report-num.mjs        reserva de números de relatório para lotes
modes/_custom.md              regra "fresh pass" (camada de usuário, fora do git)
data/pipeline.md              a fila (mais nova no topo)
data/applications.md          tracker
data/discard.log              descartes do pre-screen, com motivo (no git)
logs/                         logs e backups (fora do git)
```

---

## 13. Guia diário passo a passo, por cenário

Um comando por passo. Rode na raiz do repo (`cd ~/career-ops`). `/career-ops ...` é dentro do Claude Code.

### A. Dia normal (cron rodou): 5-15 min
1. `grep '=== ' logs/daily-scan.log logs/remote-latam-cron.log | tail -6` → `done` de hoje (~07:00 e ~07:20)
2. `node scripts/fresh-pending.mjs` → quantas vagas frescas
3. `/career-ops pipeline --fresh-only` → avalia só as com menos de 2 dias
4. Score ≥ 4.0: `/career-ops pdf`, depois `/career-ops apply` (o sistema preenche; você clica Submit)
5. Depois de enviar de verdade: `node set-status.mjs N Applied --on AAAA-MM-DD`, depois `node followup-seed.mjs N --date AAAA-MM-DD`

### B. Cron não disparou (WSL desligado às 07:00)
1. `service cron status` → se parado: `sudo service cron start`
2. `scripts/run-daily-scan.sh`
3. `scripts/run-remote-latam-scan.sh`
4. Siga o cenário A a partir do passo 2

### C. Voltou de folga ou fim de semana (intervalo > 3 dias)
1. `JOBAGE=7 scripts/run-daily-scan.sh`
2. `JOBAGE=7 scripts/run-remote-latam-scan.sh`
3. `node scripts/fresh-pending.mjs`; se o backlog estiver grande, avaliação por recorte (seção 7b)

### D. Varredura manual (2-3x/semana: LinkedIn + Vagas.com)
1. `scripts/run-manual-scan.sh --dry-run` → confere o funil
2. `scripts/run-manual-scan.sh` (`JOBAGE=4 scripts/run-manual-scan.sh` se o intervalo passou de 3 dias)
3. `tail -3 logs/import-age.tsv` → se bateu no teto de página, `--pages 2` só nessa rodada

### E. Avaliar o backlog (2-3x/semana)
1. `node scripts/fresh-pending.mjs`
2. `/career-ops pipeline` (ou o recorte da seção 7b)
3. `node merge-tracker.mjs` uma vez no fim do lote; confira as linhas "Update" na saída

### F. Candidatura
1. `/career-ops apply N` → preenche e para antes do Submit
2. Você clica Submit e diz "enviei"
3. `node set-status.mjs N Applied --on AAAA-MM-DD`, depois `node followup-seed.mjs N --date AAAA-MM-DD`

### G. Resposta de recrutador ou entrevista
1. `node invite-match.mjs` (convite colado) ou `node paste-reply.mjs` (e-mail colado)
2. `/career-ops reply-watch`
3. `node set-status.mjs N Responded` (ou `Interview`, `Rejected`)
4. Entrevista marcada: `/career-ops interview-prep`

### H. Semanal (sexta)
1. `node followup-cadence.mjs`
2. `node verify-pipeline.mjs` (0 erros)
3. `node check-jd-archive.mjs --summary` e `node stats.mjs --summary`
4. `/career-ops patterns` se houver 20-30 avaliações novas
5. `node update-system.mjs check`

### I. Fonte remota quebrou ou veio pouca vaga
1. `tail -5 logs/remote-latam.tsv` → coluna `error` preenchida ou `fetched=0`
2. `scripts/run-remote-latam-scan.sh --dry-run --source ID` → isola a fonte
3. Se persistir: `enabled: false` dessa fonte em `remote-latam.yml` até corrigir

### J. Diagnóstico rápido
| Sintoma | Comando |
|---|---|
| Sem `start` de hoje no log | `service cron status`, `crontab -l`; cenário B |
| `already running, skipping` | `pgrep -af 'run-daily-scan\|run-remote-latam'`; espere ou encerre o travado |
| Fila fora de ordem | `node scripts/import-jobs.mjs --sort-only` |
| Fila quebrada após limpeza | restaurar de `logs/pipeline.before-*.md` |
