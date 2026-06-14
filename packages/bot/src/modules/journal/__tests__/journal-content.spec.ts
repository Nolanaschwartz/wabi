import { extractInlineJournalContent } from '../journal-content';

describe('extractInlineJournalContent', () => {
  it('returns the entry text when content follows a "journal:" trigger', () => {
    expect(
      extractInlineJournalContent('journal: had a rough ranked night, feel worthless at the game'),
    ).toBe('had a rough ranked night, feel worthless at the game');
  });

  it('strips a natural-language lead-in and keeps the substantive remainder', () => {
    expect(
      extractInlineJournalContent('i want to journal about how badly i played and how alone i feel'),
    ).toBe('about how badly i played and how alone i feel');
  });

  it('returns null for a bare intent with no content (two-turn path territory)', () => {
    expect(extractInlineJournalContent('i want to journal')).toBeNull();
    expect(extractInlineJournalContent('journal')).toBeNull();
    expect(extractInlineJournalContent('can i journal?')).toBeNull();
  });

  it('returns null when the remainder is too thin to be a real entry', () => {
    // Below the substantive-content floor — treat as a bare intent, not an entry.
    expect(extractInlineJournalContent('journal: today')).toBeNull();
  });

  it('handles content with no trigger verb at all (whole message is the entry)', () => {
    // The router already decided intent=journal; if there is no lead-in to strip, the message IS the entry.
    expect(
      extractInlineJournalContent('lost five ranked games in a row and i feel completely hopeless'),
    ).toBe('lost five ranked games in a row and i feel completely hopeless');
  });
});
