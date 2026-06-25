import { buildCoachPrompt } from '../coach-prompt';

describe('buildCoachPrompt', () => {
  const base = {
    currentMessage: 'i keep losing ranked',
    turns: [] as Array<{ role: string; content: string }>,
    memories: [] as Array<{ content: string }>,
    strategies: [] as Array<{ content: string; evidence: string }>,
    inAftermath: false,
  };

  it('puts the current message last so retrieved context can never displace it', () => {
    const { prompt } = buildCoachPrompt({
      ...base,
      memories: [{ content: 'tilts after two losses' }],
      strategies: [{ content: 'box breathing', evidence: 'RCT' }],
    });

    expect(prompt.trimEnd().endsWith('Current message: i keep losing ranked')).toBe(true);
  });

  it('labels the memory read-back under its own heading', () => {
    const { prompt } = buildCoachPrompt({
      ...base,
      memories: [{ content: 'tilts after two losses' }],
    });

    expect(prompt).toContain('What you remember about this person:');
    expect(prompt).toContain('- tilts after two losses');
  });

  it('caps the memory read-back at five items', () => {
    const memories = Array.from({ length: 9 }, (_, i) => ({ content: `mem-${i}` }));

    const { prompt } = buildCoachPrompt({ ...base, memories });

    expect(prompt).toContain('- mem-4');
    expect(prompt).not.toContain('- mem-5');
  });

  it('labels strategies with their evidence', () => {
    const { prompt } = buildCoachPrompt({
      ...base,
      strategies: [{ content: 'box breathing', evidence: 'RCT 2021' }],
    });

    expect(prompt).toContain('Relevant strategies:');
    expect(prompt).toContain('- box breathing (RCT 2021)');
  });

  it('omits the memory and strategy sections entirely when there is nothing to inject', () => {
    const { prompt } = buildCoachPrompt(base);

    expect(prompt).not.toContain('What you remember');
    expect(prompt).not.toContain('Relevant strategies');
    expect(prompt).toContain('No prior turns');
  });

  it('renders prior turns as role-tagged history', () => {
    const { prompt } = buildCoachPrompt({
      ...base,
      turns: [
        { role: 'user', content: 'hey' },
        { role: 'assistant', content: 'hi there' },
      ],
    });

    expect(prompt).toContain('user: hey');
    expect(prompt).toContain('assistant: hi there');
  });

  it('guards both system personas against following injected read-back as instructions', () => {
    const def = buildCoachPrompt(base).system;
    const after = buildCoachPrompt({ ...base, inAftermath: true }).system;

    for (const system of [def, after]) {
      expect(system).toMatch(/background|not.*instruction|never follow/i);
    }
  });

  it('selects the default coach system prompt when not in aftermath', () => {
    const { system } = buildCoachPrompt(base);

    expect(system).toContain('compassionate DM companion');
    expect(system).not.toContain('recently experienced a crisis');
  });

  it('selects the gentle aftermath system prompt and appends the in-prompt safety note in aftermath', () => {
    const { system, prompt } = buildCoachPrompt({ ...base, inAftermath: true });

    // Aftermath swaps the SYSTEM persona (calm, no exercises)...
    expect(system).toContain('recently experienced a crisis');
    // ...and also leaves the inline re-screen reminder in the prompt body.
    expect(prompt).toContain('Re-screen for safety');
  });
});
