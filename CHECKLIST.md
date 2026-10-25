# Checklist diário (tudo manual, janela de 4 dias)

Sem cron. Roda toda manhã, nessa ordem. Detalhe: `docs/RUNBOOK-pipeline-diario.md` · fluxo: `WORKFLOW.md`.

Prioridade da fila: **T1** remoto LATAM de IA/ML/dados/governança → **T2** gerente/diretor/head de IA e Dados (remoto ou São Paulo híbrido) → **T3** o resto.

## FORA do Claude (terminal, `cd ~/career-ops`)

- [ ] `scripts/run-daily-scan.sh` — Gupy + portais (termina com `daily-scan done`)
- [ ] `scripts/run-remote-latam-scan.sh` — boards remotos, FreeHire, Himalayas (termina com `remote-latam-scan done`)
- [ ] `node scripts/fresh-pending.mjs` — frescas dos últimos 4 dias, já em T1 → T2 → T3

2-3x por semana (LinkedIn + Vagas.com):

- [ ] `scripts/run-manual-scan.sh --dry-run`, depois `scripts/run-manual-scan.sh`

Passou de 4 dias sem rodar? Alargue a janela só nessa rodada: `JOBAGE=7 scripts/run-daily-scan.sh` e `JOBAGE=7 scripts/run-remote-latam-scan.sh`.

## DENTRO do Claude (`claude` na raiz do repo)

- [ ] `/career-ops pipeline --fresh-only` — avalia os últimos 4 dias, T1 e T2 antes de T3
- [ ] Score ≥ 4.0 (3.0-3.9 só com motivo): `/career-ops pdf`, depois `/career-ops apply N` — o sistema preenche e para; **você** clica Submit
- [ ] Depois de enviar de verdade, de volta ao terminal:
  - `node set-status.mjs N Applied --on AAAA-MM-DD`
  - `node followup-seed.mjs N --date AAAA-MM-DD`

## Sexta

- [ ] `node followup-cadence.mjs`
- [ ] `node verify-pipeline.mjs` (0 erros) · `node check-jd-archive.mjs --summary` · `node stats.mjs --summary`
- [ ] `/career-ops patterns` (se houver 20-30 avaliações novas)

## Deu errado?

| Sintoma | Comando |
|---|---|
| Fonte remota quebrou ou veio pouca vaga | `tail -5 logs/remote-latam.tsv`; `scripts/run-remote-latam-scan.sh --dry-run --source ID` |
| `already running, skipping` | `pgrep -af 'run-daily-scan\|run-remote-latam'` |
| Fila fora de ordem | `node scripts/import-jobs.mjs --sort-only` |
