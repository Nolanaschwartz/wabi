# Source-API fixtures

Real responses captured from the live **NCBI E-utilities + BioC** and **medRxiv** APIs. The
`*.fixtures.spec.ts` specs replay these so the source adapters are tested against the APIs' *actual*
shapes — not hand-written guesses. (Hand-written mocks once hid two real `fullText` bugs: BioC
returns a top-level array, and the endpoint needs the `PMC`-prefixed id.)

Refresh with `packages/research/scripts/capture-fixtures.sh`, then run
`pnpm -F @wabi/research test -- fixtures`. A shape change shows up as a failing assertion.

| File | Source call | Notes |
|------|-------------|-------|
| `esearch.json` | esearch.fcgi (JSON) | `esearchresult.idlist` |
| `esummary.json` | esummary.fcgi (JSON) | PMID 34542434 → title, pubtype, `articleids` incl. `pmc: PMC8314311` |
| `efetch-abstract.txt` | efetch.fcgi (text) | raw metadata-laden blob (citation header + DOI + abstract) |
| `elink.json` | elink.fcgi (JSON) | neighbor PMIDs; **includes the query PMID itself** |
| `elink-error.json` | elink.fcgi (JSON) | real **HTTP 200 + `ERROR` + empty `linksets`** transient-failure shape; `related()` must return `[]` |
| `bioc.json` | BioC_json/PMC8314311/unicode | **top-level array** `[{documents:[{passages:[{text}]}]}]` (~126 KB) |
| `medrxiv-details.json` | medRxiv details window (JSON) | `collection[]` of 100 records; filter keys `doi/title/abstract/date` |
| `sample.pdf` | — | tiny valid PDF for the `doc.ts` fetch+parse path |
| `sample.docx` | — | tiny synthetic DOCX (3 OOXML parts; marker "Hello mammoth fixture body") for the `doc.ts` mammoth path; built once with `zip`, not captured |

Coherent around one stable open-access paper: **PMID 34542434 / PMC8314311**.

`elink-error.json` is hand-preserved (not re-captured by the script) to pin the failure shape.

Drift detection: the specs also carry opt-in **LIVE** blocks that hit the real APIs —
`RESEARCH_LIVE=1 pnpm -F @wabi/research test -- fixtures` — skipped by default.
