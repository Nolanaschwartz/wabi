// The single home for the voice surface's recall decision. Pure: all I/O (identity lookup, Mem0
// recall) is injected, so the privacy-critical gate is provable with no Discord/Prisma/network.

/** Minimal member shape the bridge maps a discord.js GuildMember to (id + whether it's a bot). */
export interface CallMember {
  id: string;
  isBot: boolean;
}

export interface BuildMemoryContextDeps {
  members: CallMember[];
  /** Discord id -> wabi User.id, or null if there is no User record. */
  resolveUserId: (discordId: string) => Promise<string | null>;
  /** wabi User.id -> derived-memory facts. */
  recall: (userId: string) => Promise<string[]>;
}

/**
 * Build the memory block to prepend to the assistant's system prompt, or '' to inject nothing.
 *
 * Privacy gate (ADR-0002/0017): personal/inner-state memory must never reach a shared/social surface.
 * A voice channel can hold more than one human, so recall happens ONLY when exactly one human is
 * present — with 0 or 2+ humans we return '' and never even call recall.
 */
export async function buildMemoryContext({
  members,
  resolveUserId,
  recall,
}: BuildMemoryContextDeps): Promise<string> {
  const humans = members.filter((m) => !m.isBot);
  if (humans.length !== 1) return ''; // 0 or 2+ humans -> never recall, never inject

  const userId = await resolveUserId(humans[0].id);
  if (!userId) return ''; // unknown user gets nothing (the DM rule, on voice)

  const facts = await recall(userId);
  return formatMemoryBlock(facts);
}

/** Render facts as the system-prompt memory block, or '' when there are none. */
export function formatMemoryBlock(facts: string[]): string {
  if (facts.length === 0) return '';
  return `What you remember about them:\n- ${facts.join('\n- ')}`;
}

/** Append the memory block to the base system prompt, leaving it unchanged when the block is empty. */
export function composeSystemPrompt(base: string, memoryBlock: string): string {
  return memoryBlock ? `${base}\n\n${memoryBlock}` : base;
}
