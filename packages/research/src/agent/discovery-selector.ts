import type { ResearchGenerate } from './research-generate';
import { stripFences } from './extract';

export interface NeighborTitle { id: string; title: string }

/** Topic-aware selection of which relatedness-ranked neighbors to chase. The deterministic top-`maxChase`
 * of `neighbors` is the fail-open floor: any error / empty / unparseable / out-of-range output returns it,
 * so discovery always yields some topically-plausible papers even when the model step fails (ADR-0021). */
export async function selectNeighbors(
  gen: ResearchGenerate,
  topic: string,
  source: { title: string; abstract: string },
  neighbors: NeighborTitle[],
  maxChase: number,
): Promise<{ ids: string[]; tokens: number }> {
  const floor = () => neighbors.slice(0, maxChase).map((n) => n.id);
  if (neighbors.length === 0) return { ids: [], tokens: 0 };

  const prompt =
    `Run topic: "${topic}". A source paper and its related papers (by title) are below. Pick the ` +
    `related papers most likely to describe a self-administered, non-clinical coping/wellbeing ` +
    `technique relevant to the topic. Choose at most ${maxChase}.\n` +
    `Return JSON: {"chase": number[]} — the 0-based indices to chase (or {"chase": []}).\n` +
    `Output only the JSON object — no prose.\n\n` +
    `Source: ${source.title}\n${source.abstract}\n\n` +
    `Related:\n${neighbors.map((n, i) => `${i}: ${n.title}`).join('\n')}`;

  let out;
  try {
    out = await gen('discovery', 'research-triage', { prompt });
  } catch {
    return { ids: floor(), tokens: 0 };
  }
  const tokens = out.usage?.totalTokens ?? 0;

  let chase: unknown;
  try {
    chase = (JSON.parse(stripFences(out.text.trim())) as { chase?: unknown }).chase;
  } catch {
    return { ids: floor(), tokens };
  }
  if (!Array.isArray(chase)) return { ids: floor(), tokens };

  const ids = chase
    .filter((i): i is number => Number.isInteger(i) && i >= 0 && i < neighbors.length)
    .slice(0, maxChase)
    .map((i) => neighbors[i].id);

  return { ids, tokens }; // explicit selection (possibly empty) is honored; floor() is only for failures
}
