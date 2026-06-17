#!/usr/bin/env bash
#
# Refresh the captured PubMed/medRxiv fixtures used by *.fixtures.spec.ts.
#
# These fixtures are REAL responses from the live NCBI E-utilities + BioC and medRxiv APIs. They
# exist so the source-adapter tests assert against the APIs' actual shapes rather than our guesses
# (hand-written mocks once hid two real fullText bugs). Re-run this when you suspect API drift, then
# run the specs — a diff in shape will surface as a failing assertion.
#
# Paced for NCBI's keyless 3 req/s cap. Set NCBI_API_KEY to go faster. Requires curl.
#
# Usage:  ./packages/research/scripts/capture-fixtures.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../src/sources/__tests__/fixtures" && pwd)"
EUTILS="https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
BIOC="https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json"
KEY="${NCBI_API_KEY:+&api_key=${NCBI_API_KEY}}"
PAUSE="${CAPTURE_PAUSE_SECONDS:-2}"

# Coherent around one stable open-access paper: PMID 34542434 / PMC8314311.
PMID=34542434
PMC=PMC8314311

echo "Capturing fixtures into $DIR (PMID $PMID, pause ${PAUSE}s) ..."

curl -fsS "${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&retmax=3&term=progressive+muscle+relaxation+anxiety${KEY}" -o "$DIR/esearch.json"; sleep "$PAUSE"
curl -fsS "${EUTILS}/esummary.fcgi?db=pubmed&retmode=json&id=${PMID}${KEY}" -o "$DIR/esummary.json"; sleep "$PAUSE"
curl -fsS "${EUTILS}/efetch.fcgi?db=pubmed&rettype=abstract&retmode=text&id=${PMID}${KEY}" -o "$DIR/efetch-abstract.txt"; sleep "$PAUSE"
curl -fsS "${EUTILS}/elink.fcgi?dbfrom=pubmed&db=pubmed&cmd=neighbor&retmode=json&id=${PMID}${KEY}" -o "$DIR/elink.json"; sleep "$PAUSE"
curl -fsS "${BIOC}/${PMC}/unicode" -o "$DIR/bioc.json"
curl -fsS "https://api.medrxiv.org/details/medrxiv/2024-01-01/2024-01-05/0/json" -o "$DIR/medrxiv-details.json"

# elink-error.json is a hand-preserved real NCBI "200 + ERROR + empty linksets" response and is
# NOT overwritten here (it documents the transient-failure shape related() must tolerate).

echo "Done. Verify with: pnpm -F @wabi/research test -- fixtures"
