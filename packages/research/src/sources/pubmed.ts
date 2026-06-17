import { RateLimiter } from '../util/rate-limiter';
import { sourceMaxTextChars } from '../config';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const BIOC = 'https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json';
const EUROPEPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

export interface PubMedDeps {
  fetchFn?: typeof fetch;
  apiKey?: string;
  minIntervalMs?: number; // default 350ms (~3/s keyless)
  maxTextChars?: number;  // full-text char cap (default 50k; env RESEARCH_PUBMED_MAX_TEXT_CHARS)
}

/** Strip XML tags to plain text. The LLM extractor tolerates residual markup, so this is a cheap
 * tag-strip + entity-decode + whitespace-collapse, not a real parser. */
function stripXml(xml: string): string {
  return xml
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export class PubMedTool {
  private readonly fetchFn: typeof fetch;
  private readonly apiKey?: string;
  private readonly limiter: RateLimiter;
  private readonly maxTextChars: number;

  constructor(deps: PubMedDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.apiKey = deps.apiKey;
    this.limiter = new RateLimiter(deps.minIntervalMs ?? 350);
    // Env-derived default from config.ts (shared RESEARCH_MAX_TEXT_CHARS, RESEARCH_PUBMED_* override),
    // resolved lazily here (constructed per-run after ConfigModule loads), never frozen at import.
    this.maxTextChars = deps.maxTextChars ?? sourceMaxTextChars('pubmed');
  }

  private key(): string {
    return this.apiKey ? `&api_key=${this.apiKey}` : '';
  }

  private async getJson<T>(url: string): Promise<T> {
    return this.limiter.schedule(async () => {
      const res = await this.fetchFn(url);
      if (!res.ok) throw new Error(`PubMed HTTP ${res.status}`);
      return (await res.json()) as T;
    });
  }

  private async getText(url: string): Promise<string> {
    return this.limiter.schedule(async () => {
      const res = await this.fetchFn(url);
      if (!res.ok) throw new Error(`PubMed HTTP ${res.status}`);
      return res.text();
    });
  }

  async search(query: string, limit: number): Promise<string[]> {
    const url = `${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&retmax=${limit}&term=${encodeURIComponent(query)}${this.key()}`;
    const data = await this.getJson<{ esearchresult?: { idlist?: string[] } }>(url);
    return data.esearchresult?.idlist ?? [];
  }

  async summary(pmid: string): Promise<{ title: string; pubTypes: string[] }> {
    const url = `${EUTILS}/esummary.fcgi?db=pubmed&retmode=json&id=${pmid}${this.key()}`;
    const data = await this.getJson<{ result?: Record<string, { title?: string; pubtype?: string[] }> }>(url);
    const rec = data.result?.[pmid];
    return { title: rec?.title ?? '', pubTypes: rec?.pubtype ?? [] };
  }

  async abstract(pmid: string): Promise<string> {
    const url = `${EUTILS}/efetch.fcgi?db=pubmed&rettype=abstract&retmode=text&id=${pmid}${this.key()}`;
    return (await this.getText(url)).trim();
  }

  async related(pmid: string): Promise<string[]> {
    const url = `${EUTILS}/elink.fcgi?dbfrom=pubmed&db=pubmed&cmd=neighbor&retmode=json&id=${pmid}${this.key()}`;
    const data = await this.getJson<{ linksets?: { linksetdbs?: { links?: string[] }[] }[] }>(url);
    return data.linksets?.[0]?.linksetdbs?.[0]?.links ?? [];
  }

  /** Open-access full text, truncated to maxTextChars. BioC JSON is primary; when it yields nothing
   * and a PMCID is known, fall back to Europe PMC's OA full-text XML. Non-OA (no PMCID) → null. Every
   * path is fail-safe → null, so the caller reads the abstract instead. No paywalled scraping. */
  async fullText(pmid: string): Promise<string | null> {
    const pmcId = await this.pmcId(pmid);
    if (!pmcId) return null; // not open-access
    const body = (await this.biocFullText(pmcId)) ?? (await this.europePmcFullText(pmcId));
    return body ? body.slice(0, this.maxTextChars) : null;
  }

  /** The PMC-prefixed id (e.g. PMC8314311) for an OA paper, or null. Both the BioC and Europe PMC
   * endpoints require the "PMC" prefix — stripping it returns an error from the live APIs. */
  private async pmcId(pmid: string): Promise<string | null> {
    try {
      const url = `${EUTILS}/esummary.fcgi?db=pubmed&retmode=json&id=${pmid}${this.key()}`;
      const sum = await this.getJson<{ result?: Record<string, { articleids?: { idtype: string; value: string }[] }> }>(url);
      const raw = sum.result?.[pmid]?.articleids?.find((a) => a.idtype === 'pmc')?.value;
      if (!raw) return null;
      return raw.startsWith('PMC') ? raw : `PMC${raw}`;
    } catch {
      return null;
    }
  }

  private async biocFullText(pmcId: string): Promise<string | null> {
    try {
      // BioC returns a TOP-LEVEL ARRAY: [{ ..., documents: [{ passages: [{ text }] }] }].
      type BioCCollection = { documents?: { passages?: { text?: string }[] }[] };
      const bioc = await this.getJson<BioCCollection | BioCCollection[]>(`${BIOC}/${pmcId}/unicode`);
      const collection = Array.isArray(bioc) ? bioc[0] : bioc;
      const text = (collection?.documents ?? [])
        .flatMap((d) => d.passages ?? [])
        .map((p) => p.text ?? '')
        .join('\n')
        .trim();
      return text.length > 0 ? text : null;
    } catch {
      return null; // not yet in BioC / transient — try Europe PMC next
    }
  }

  private async europePmcFullText(pmcId: string): Promise<string | null> {
    try {
      const xml = await this.getText(`${EUROPEPMC}/${pmcId}/fullTextXML`);
      const text = stripXml(xml);
      return text.length > 0 ? text : null;
    } catch {
      return null; // not OA in Europe PMC / transient — caller falls back to the abstract
    }
  }
}
