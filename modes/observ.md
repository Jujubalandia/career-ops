# Mode: observ — Daily Pipeline Analytics Dashboard

Zero-token report on what's accumulating in `data/pipeline.md`: remote-Brazil postings by category, AI-Management vs Data-Management counts, postings grouped by posted date, on-site/hybrid/remote split, counts by region (including an interior-São-Paulo Campinas/Bragança-Paulista/Extrema-MG breakout), a best-fit shortlist from the existing `rank:` field, and the interior-SP/Extrema-MG IT postings specifically.

> **Non-negotiables:**
> - **Read-only.** This mode NEVER writes to `data/pipeline.md`, `data/scan-history.tsv`, `data/applications.md`, or any report file. It reads and prints.
> - **Deterministic, zero-LLM.** The numbers come from `observ.mjs` (pure local parsing — no network, no keys). Do not recompute, adjust, or estimate anything it doesn't print.
> - **Every bucket is a keyword classification, not a verified fact.** There is no structured category/region/remote-type field anywhere in the pipeline — `observ.mjs` infers all three from free-text title/location strings. Always carry the caveat the script itself prints; never present a count as ground truth.
> - **Never invent a fit score.** A pending row with no `rank:` segment is "unscored" — point the user at `node rank-pipeline.mjs` if they want one, don't guess.

## Inputs

- `data/pipeline.md` — the only data source. Sections dated on the `posted:` field already present on each `- [ ] ` row.

## Step 1 — Run Script

```bash
node observ.mjs --summary                     # today's posted-date window
node observ.mjs --date 2026-09-25 --summary   # a specific date
node observ.mjs --days 7 --summary            # rolling window ending at --date
```

Or `node observ.mjs` / `--json` for the raw JSON. Parse it — the keys:

| Key | Contents |
|-----|----------|
| `metadata` | `date`, `days`, `sources.pipeline`, `totalPendingCount`, `windowRowCount`, `undatedCount`, `processedCount`, `unreachableCount` |
| `categoryCounts` | Window-scoped count per category: AI Management, Data Management, AI Governance, AI Engineering, Data Engineering, Other |
| `remoteByCategory` | Same categories, restricted to rows classified `remote` |
| `workMode` | Window-scoped counts: `remote`, `hybrid`, `onsite`, `unknown` |
| `byRegion` | Window-scoped counts: `sao_paulo_capital`, `campinas_metro`, `braganca_paulista_region`, `extrema_mg`, `other_brazil`, `unclassified` |
| `byPostedDate` | **Not window-scoped** — the full posted-date histogram across every pending row, plus `undated` |
| `interiorSPRoles` | Window-scoped list of `{url, company, title, region, category, rank}` for IT roles in `campinas_metro` / `braganca_paulista_region` / `extrema_mg` |
| `bestFit` | **Not window-scoped** — `{scored: [...top N by existing rank...], unscoredCount}` |

`byPostedDate` and `bestFit` are deliberately global rather than window-scoped: a one-day date histogram is a degenerate view, and "which pending posting fits me best" isn't a today-only question.

If `metadata.sources.pipeline` is `false`, tell the user there's no `data/pipeline.md` yet and point them at `/career-ops scan` or `/career-ops pipeline`.

## Step 2 — Display Dashboard

[Render in {language.output}] Open with the same caveat line the script prints:

> Categories/regions below are keyword-classified from title+location text, not verified — spot-check if it matters.

Then render, in this order:

1. **Pending summary** — total pending, in-window count, undated/processed/unreachable counts (so the user understands why bucket totals don't equal the full backlog).
2. **Category counts** table, and **remote-by-category** as a second column or table.
3. **Work mode** (remote/hybrid/onsite/unknown) as counts and %.
4. **By region** table. The first time `campinas_metro`, `braganca_paulista_region`, or `extrema_mg` appears with any count, add one line: *"the interior-SP/Extrema-MG region list is a draft — edit the `REGIONS` constant near the top of `observ.mjs` if a city is wrong or missing."*
5. **By posted date** — a compact date-descending list (last ~14 days is usually enough; mention the `undated` count separately).
6. **Interior SP / Extrema-MG IT roles** — the explicit list the user asked for, company + title + rank if scored.
7. **Best fit** — the top-N scored shortlist, plus the unscored count. If `unscoredCount` is large and the user wants more scored rows, mention `node rank-pipeline.mjs` as the zero-cost way to get more `rank:` annotations (it's opt-in, never automatic).

## What this mode must never do

- Never write to `data/pipeline.md`, `data/scan-history.tsv`, `data/applications.md`, or any tracker/report file — pure read + print.
- Never treat a category/region/work-mode bucket as verified — it's a keyword match over free text, always say so.
- Never invent a fit score for an unscored row.
- Never treat the interior-SP/Extrema-MG city list as authoritative geography — it's a small hand-maintained draft, not a verified municipality table.
