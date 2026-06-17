import { RateLimiter } from '../util/rate-limiter';

const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const BIOC = 'https://www.ncbi.nlm.nih.gov/research/bionlp/RESTful/pmcoa.cgi/BioC_json';

export interface PubMedDeps {
  fetchFn?: typeof fetch;
  apiKey?: string;
  minIntervalMs?: number; // default 350ms (~3/s keyless)
}

export class PubMedTool {
  private readonly fetchFn: typeof fetch;
  private readonly apiKey?: string;
  private readonly limiter: RateLimiter;

  constructor(deps: PubMedDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.apiKey = deps.apiKey;
    this.limiter = new RateLimiter(deps.minIntervalMs ?? 350);
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

  /** PMC open-access full text via BioC JSON, or null when the paper isn't OA. */
  async fullText(pmid: string): Promise<string | null> {
    const sumUrl = `${EUTILS}/esummary.fcgi?db=pubmed&retmode=json&id=${pmid}${this.key()}`;
    const sum = await this.getJson<{ result?: Record<string, { articleids?: { idtype: string; value: string }[] }> }>(sumUrl);
    const rawPmcId = sum.result?.[pmid]?.articleids?.find((a) => a.idtype === 'pmc')?.value;
    if (!rawPmcId) return null;
    // The BioC endpoint requires the "PMC"-prefixed id (e.g. PMC8314311). Stripping the prefix
    // returns "[Error] : No result can be found" — verified against the live NCBI API.
    const pmcId = rawPmcId.startsWith('PMC') ? rawPmcId : `PMC${rawPmcId}`;
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
      return null; // not OA / not yet in BioC / transient — caller falls back to the abstract
    }
  }
}
