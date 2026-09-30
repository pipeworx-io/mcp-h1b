# @pipeworx/h1b

US H-1B visa sponsorship and wage data from DOL Labor Condition Application
(LCA) disclosures — "does company X sponsor H-1B", "what does role Y pay at
company X", "who sponsors the most data engineers in Austin".

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1686+ live data sources.

## Tools

- `h1b_employer_sponsorship(employer, year?)` — filing count, salary range,
  top titles/locations for an employer.
- `h1b_salary(job_title, employer?, city?, year?, limit?)` — real disclosed
  base-salary stats + a sample of records for a role.
- `h1b_top_sponsors(job_title, city?, year?, limit?)` — employers ranked by
  filing count for a role, with median salary.

Argument names/shapes are unchanged from before fleet #2514 — only where the
answer is served from changed.

## Two-tier source (fleet #2514)

**Primary: DOL's own LCA disclosure files** for recent federal fiscal
years. Older years come from h1bdata.info. Every DOL-sourced response
carries `data_as_of`.

**Fallback: h1bdata.info**, a third-party aggregator of the same DOL data.
Used only when the requested year is outside the local mirror's loaded
window, or the DB is unreachable — this pack must never regress below its
pre-#2514 behavior while the mirror is partially backfilled. Every response
carries a `source` field saying which one actually answered it; the pack
never silently swaps sources without saying so.

**Why a mirror at all**: the live h1bdata.info scrape caps at 20,000 raw
HTML table rows per query (`fetchLcaLive`'s safety cap) — for any employer
or job title with more filings than that, salary stats and `top_sponsors`
rankings were being computed from a silently truncated, non-representative
slice. For DOL-sourced years, `top_sponsors` aggregates over
**every** matching row, with no such cap (see `total_all_filings` in
`222_h1b_lca_disclosures.sql`'s `h1b_top_sponsors` RPC, a window-function sum
computed before the row-limit).

**Fiscal year, not calendar year, on the local mirror.** DOL's files are
organized by federal fiscal year (Oct 1 - Sep 30); `year` is passed straight
through as that fiscal year when served locally. h1bdata.info's own "year"
filter is a different, unverified semantic (most likely calendar year) — a
query answered by each path for the same `year` value is not guaranteed to
cover the identical 12 months. The response's `note`/`source` fields say
which happened; this is a real, disclosed difference, not papered over.

## PERSONAL-DATA RULE (mandatory, local-copy rule — task #2514)

DOL's own record layout (`LCA_Record_Layout_FY2024_Q4.pdf`, read in full
2026-09-29) carries named-individual contact fields that are **never read
into the mirror** — `scripts/h1b-lca-transform.py` uses an ALLOWLIST of
source columns (not a blocklist), so a column DOL adds later is excluded by
default:

- `EMPLOYER_POC_{LAST,FIRST,MIDDLE}_NAME`, `EMPLOYER_POC_EMAIL`,
  `EMPLOYER_POC_PHONE` — the employer's named point of contact.
- `AGENT_ATTORNEY_{LAST,FIRST,MIDDLE}_NAME`,
  `AGENT_ATTORNEY_EMAIL_ADDRESS`, `AGENT_ATTORNEY_PHONE` — the attorney/agent
  representing the employer.
- `PREPARER_{LAST,FIRST,MIDDLE}_NAME`, `PREPARER_EMAIL` — whoever filled out
  the form.

DOL's file already excludes the foreign worker's own name/address (DOL's own
cover note names only "Attorney's FEIN and Attorney's State Bar Number" as
withheld — no worker PII was ever in this dataset). Kept: `EMPLOYER_NAME` /
`TRADE_NAME_DBA` and employer address down to city/state/country (no
street), plus job/wage/worksite fields — this identifies the employer making
a mandatory public disclosure, not a private individual.

## Data source

- `https://www.dol.gov/agencies/eta/foreign-labor/performance` — DOL OFLC
  performance-data page, links each fiscal year's disclosure file.
- **Verified live 2026-09-29 (not documented by DOL, reverse-engineered from
  `decision_date` distributions — the record-layout PDF's cover text is
  WRONG about this for closed years):**
  - The **current, still-open** fiscal year's latest quarterly file is
    **cumulative** from Oct 1 of that FY through the end of the named
    quarter (`FY2026_Q3.xlsx` spans Oct 2025-Jun 2026). Lives at
    `https://www.dol.gov/media/LCA_Disclosure_Data_<label>.xlsx`. Load only
    the single latest file for an open year.
  - Once a fiscal year **closes**, DOL's archived quarterly files for that
    year are each **discrete** — `decision_date` falls only within that one
    quarter (verified: `FY2025_Q3.xlsx` = Apr-Jun 2025 only, `FY2025_Q4.xlsx`
    = Jul-Sep 2025 only — NOT the full year, despite the record-layout PDF
    literally stating "Reporting Period: October 1 ... through September 30"
    on its cover page). Lives at
    `https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_<label>.xlsx`.
    A closed year needs **all four** of its quarter files for full coverage;
    they do not overlap.
- No auth, no rate limit observed. US federal administrative data — public
  domain.

## Ingest harness

- `supabase/migrations/222_h1b_lca_disclosures.sql` — `h1b_lca_disclosures`
  table + `h1b_lca_ingest_runs` bookkeeping + three RPCs (`h1b_lca_search`,
  `h1b_top_sponsors`, `h1b_lca_coverage`). RLS on; `anon`/`authenticated`
  have no grants; `service_role` only.
- `scripts/h1b-lca-transform.py` — streams one `.xlsx` file row-by-row via
  `openpyxl(read_only=True)` (never buffers a whole workbook — a full fiscal
  year runs 80-250MB uncompressed), allowlist-selects the non-personal
  columns, and computes `base_salary_annual` from
  `WAGE_RATE_OF_PAY_FROM`/`WAGE_UNIT_OF_PAY` (Hour×2080, Week×52,
  Bi-Weekly×26, Month×12, Year×1).
- `scripts/h1b-lca-upsert.sh` — per file: download (tries the current-year
  URL, falls back to the closed-year archive URL), transform, `\copy` into a
  staging table, then `INSERT ... ON CONFLICT (case_number) DO UPDATE`
  (`CASE_NUMBER` is DOL's own stable per-application id — no synthetic key
  needed).
- `.github/workflows/h1b-lca-refresh.yml` — `workflow_dispatch` only
  (deliberately no `schedule:` — Bruce's "supa stagger" rule queues big
  Supabase loads one at a time, overnight, on purpose; GitHub's `schedule:`
  trigger has also been unreliable fleet-wide since ~2026-09-09). Default
  `files` input is the "latest 8 quarters" the task asked for, with verified
  zero overlap and zero gap:
  `2026:FY2026_Q3` (cumulative, = FY2026 Q1+Q2+Q3) +
  `2025:FY2025_Q1,2025:FY2025_Q2,2025:FY2025_Q3,2025:FY2025_Q4` (four
  discrete quarters) + `2024:FY2024_Q4` (one discrete quarter) — 6 files,
  Jul 2024-Jun 2026.

### Observed sizes/rows (live, 2026-09-29 — proof-of-transform run, not a full load)

| File | Bytes | Real data rows |
|---|---|---|
| FY2026_Q3 (cumulative, Oct'25-Jun'26) | 251,850,891 | 437,496 |
| FY2025_Q4 (Jul-Sep'25 only) | 79,134,156 | 118,580 |
| FY2025_Q3 (Apr-Jun'25 only) | 143,867,250 | 238,425 |
| FY2025_Q2 (Jan-Mar'25 only) | 106,951,050 | not downloaded — est. ~175k by size ratio |
| FY2025_Q1 (Oct-Dec'24 only) | 87,690,398 | not downloaded — est. ~145k by size ratio |
| FY2024_Q4 (Jul-Sep'24 only) | 83,056,843 | not downloaded — est. ~120k by size ratio |

Estimated total for the default 6-file load: **~1.2-1.3M rows**, ~650MB of
xlsx downloads. Every `.xlsx` sheet carries a large trailing block of
genuinely-empty phantom rows past the real data (e.g. FY2026_Q3's declared
sheet dimension is 1,032,736 rows for 437,496 real ones) — this is a DOL
export artifact, not a bug in the transform script; those rows are dropped
and counted as "without CASE_NUMBER".

## Known source data-quality trap

DOL's raw `WAGE_RATE_OF_PAY_FROM`/`WAGE_UNIT_OF_PAY` occasionally disagree in
a way that produces an absurd `base_salary_annual` (an observed FY2026_Q3
row annualizes to ~$453M — almost certainly a unit-entry error by the filer,
kept verbatim rather than "corrected", same discipline as `sba_loans`
keeping literal duplicate/conflicting source rows). `median`-based stats are
resistant to this; a `max` in a response can occasionally show one of these
outliers — that is the source data, not a mirror defect.

## Gotchas

- The live DOL `.xlsx` header spells the H-1B-dependent-employer column
  `H_1B_DEPENDENT` (underscore) — the *record-layout PDF* spells it
  `H-1B_DEPENDENT` (hyphen). Trust the live file; verified against
  `FY2026_Q3.xlsx` 2026-09-29.
- Do not load more than one file per still-open fiscal year, and do not load
  a closed year's file without all four of its quarters — see "Data source"
  above. Getting this wrong either duplicates rows (double-counting an
  overlapping cumulative + discrete file) or leaves silent gaps.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "h1b": {
      "url": "https://gateway.pipeworx.io/h1b/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/h1b/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1686+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/h1b_employer_sponsorship \
  -H 'Content-Type: application/json' \
  -d '{"employer":"Google","year":2024}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/h1b_employer_sponsorship`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "h1b": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-h1b"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-h1b
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about H1b data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
