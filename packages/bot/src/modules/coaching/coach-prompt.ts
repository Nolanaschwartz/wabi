/**
 * Coach prompt assembly — the single place that turns the gathered context (history, derived
 * memory, retrieved strategies, aftermath state) into the exact {system, prompt} pair the model
 * sees. Pure: no I/O. The orchestrator (CoachingService) does the gathering; CoachService does the
 * model call. Keeping all prompt *shaping* here means "what does the coach see?" is one readable,
 * unit-testable function instead of a string smeared across two services — and it's the one seam
 * where untrusted read-back (memory/strategy text) is labelled and the user's current message is
 * pinned last, so retrieved context can't silently displace it.
 */

const MAX_MEMORIES = 5;

const SYSTEM_DEFAULT =
  'You are Wabi, a compassionate DM companion for gamers. You offer warm, brief coaching that helps players reflect on tilt, stress, and life balance. Never give clinical advice or diagnose. Keep responses under 400 characters. Speak naturally, like a friend who cares. If the user mentions feeling genuinely distressed or suicidal, say you cannot help with that and direct them to professional resources.';

const SYSTEM_AFTERMATH =
  'You are Wabi. The user recently experienced a crisis. Be gentle, warm, and supportive. Use a calm tone — no cheerful or energetic language. Do NOT suggest tilt sessions or coaching exercises. Keep responses brief and caring. Never give clinical advice or diagnose. Re-screen for safety signals. Keep responses under 300 characters.';

export interface CoachPromptTurn {
  role: string;
  content: string;
}

export interface CoachPromptInput {
  currentMessage: string;
  turns: CoachPromptTurn[];
  memories: Array<{ content: string }>;
  strategies: Array<{ content: string; evidence: string }>;
  inAftermath: boolean;
}

export interface CoachPrompt {
  system: string;
  prompt: string;
}

export function buildCoachPrompt(input: CoachPromptInput): CoachPrompt {
  const { currentMessage, turns, memories, strategies, inAftermath } = input;

  const turnHistory = turns
    .map((t) => `${t.role}: ${t.content}`)
    .join('\n')
    .trim();

  // Read-back: surface what we've learned about this person (self-hosted Memory).
  const memoryContext =
    memories.length > 0
      ? `\nWhat you remember about this person:\n${memories
          .slice(0, MAX_MEMORIES)
          .map((m) => `- ${m.content}`)
          .join('\n')}`
      : '';

  const strategyContext =
    strategies.length > 0
      ? `\nRelevant strategies:\n${strategies.map((s) => `- ${s.content} (${s.evidence})`).join('\n')}`
      : '';

  let prompt = `Conversation history:\n${turnHistory || 'No prior turns'}`;
  prompt += memoryContext;
  prompt += strategyContext;
  if (inAftermath) {
    prompt +=
      '\n\nIMPORTANT: The user recently experienced a crisis. Be gentle and supportive. Avoid cheerful or energetic tone. Re-screen for safety.';
  }
  // Pinned last: the live turn is the instruction the model acts on, never outranked by read-back.
  prompt += `\n\nCurrent message: ${currentMessage}`;

  return { system: inAftermath ? SYSTEM_AFTERMATH : SYSTEM_DEFAULT, prompt };
}
