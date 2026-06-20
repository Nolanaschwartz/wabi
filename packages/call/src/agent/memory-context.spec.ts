import { buildMemoryContext, composeSystemPrompt } from './memory-context';

const human = (id: string) => ({ id, isBot: false });
const bot = (id: string) => ({ id, isBot: true });

// resolveUserId/recall are injected so the privacy gate is provable with no Discord/Prisma/network.
const resolveTo = (userId: string | null) => jest.fn(async () => userId);

describe('buildMemoryContext — single-human privacy gate (ADR-0002)', () => {
  it('returns empty and never recalls when no humans are present', async () => {
    const recall = jest.fn(async () => ['fact']);
    const block = await buildMemoryContext({
      members: [bot('bot-1')],
      resolveUserId: resolveTo('u1'),
      recall,
    });
    expect(block).toBe('');
    expect(recall).not.toHaveBeenCalled();
  });

  it('injects the one human’s facts when exactly one human is present', async () => {
    const block = await buildMemoryContext({
      members: [human('d1'), bot('bot-1')],
      resolveUserId: resolveTo('u1'),
      recall: async () => ['likes Valorant', 'tilts after losses'],
    });
    expect(block).toContain('likes Valorant');
    expect(block).toContain('tilts after losses');
  });

  it('returns empty and never recalls when two or more humans are present', async () => {
    const recall = jest.fn(async () => ['private fact']);
    const block = await buildMemoryContext({
      members: [human('d1'), human('d2')],
      resolveUserId: resolveTo('u1'),
      recall,
    });
    expect(block).toBe('');
    expect(recall).not.toHaveBeenCalled(); // no personal fact can reach a shared surface
  });

  it('returns empty for an unknown user (no User record)', async () => {
    const recall = jest.fn(async () => ['fact']);
    const block = await buildMemoryContext({
      members: [human('d1')],
      resolveUserId: resolveTo(null),
      recall,
    });
    expect(block).toBe('');
    expect(recall).not.toHaveBeenCalled();
  });

  it('returns empty when the known user has no facts', async () => {
    const block = await buildMemoryContext({
      members: [human('d1')],
      resolveUserId: resolveTo('u1'),
      recall: async () => [],
    });
    expect(block).toBe('');
  });

  it('resolves the human’s own Discord id, not a bot’s', async () => {
    const resolveUserId = resolveTo('u1');
    await buildMemoryContext({
      members: [bot('bot-1'), human('d1')],
      resolveUserId,
      recall: async () => ['fact'],
    });
    expect(resolveUserId).toHaveBeenCalledWith('d1');
  });
});

describe('composeSystemPrompt', () => {
  it('leaves the base prompt unchanged when there is no memory block', () => {
    expect(composeSystemPrompt('BASE', '')).toBe('BASE');
  });

  it('appends the memory block when present', () => {
    const out = composeSystemPrompt('BASE', 'What you remember about them:\n- x');
    expect(out.startsWith('BASE')).toBe(true);
    expect(out).toContain('What you remember about them:\n- x');
  });
});
