// UserService imports @wabi/shared at load; AccountReads only delegates to it, so stub the module
// to keep the import graph clean — the spec injects a plain mock UserService.
jest.mock('@wabi/shared', () => ({}));

import { AccountReads } from '../account-reads.service';

function make() {
  const findByDiscordId = jest.fn();
  const reads = new AccountReads({ findByDiscordId } as any);
  return { reads, findByDiscordId };
}

describe('AccountReads', () => {
  describe('consentState', () => {
    it('reports consented (with timezone) when consentAcceptedAt is set', async () => {
      const { reads, findByDiscordId } = make();
      findByDiscordId.mockResolvedValue({
        consentAcceptedAt: new Date('2026-01-01'),
        timezone: 'Europe/Berlin',
      });

      await expect(reads.consentState('d1')).resolves.toEqual({
        consented: true,
        timezone: 'Europe/Berlin',
      });
    });

    it('reports not consented when consentAcceptedAt is null', async () => {
      const { reads, findByDiscordId } = make();
      findByDiscordId.mockResolvedValue({ consentAcceptedAt: null, timezone: 'UTC' });

      await expect(reads.consentState('d1')).resolves.toEqual({
        consented: false,
        timezone: 'UTC',
      });
    });

    it('reports not consented for an unknown user', async () => {
      const { reads, findByDiscordId } = make();
      findByDiscordId.mockResolvedValue(null);

      await expect(reads.consentState('d1')).resolves.toEqual({
        consented: false,
        timezone: 'UTC',
      });
    });

    it('defaults timezone to UTC when the column is null', async () => {
      const { reads, findByDiscordId } = make();
      findByDiscordId.mockResolvedValue({ consentAcceptedAt: new Date(), timezone: null });

      await expect(reads.consentState('d1')).resolves.toEqual({
        consented: true,
        timezone: 'UTC',
      });
    });

    it('projects only the DM-entry columns — no full-row over-fetch', async () => {
      const { reads, findByDiscordId } = make();
      findByDiscordId.mockResolvedValue(null);

      await reads.consentState('d1');

      expect(findByDiscordId).toHaveBeenCalledWith('d1', {
        consentAcceptedAt: true,
        timezone: true,
      });
    });

    it('fails safe to not-consented when the read throws (ADR-0021)', async () => {
      const { reads, findByDiscordId } = make();
      findByDiscordId.mockRejectedValue(new Error('db down'));

      await expect(reads.consentState('d1')).resolves.toEqual({
        consented: false,
        timezone: 'UTC',
      });
    });
  });

  describe('localeFor', () => {
    it('returns the user locale', async () => {
      const { reads, findByDiscordId } = make();
      findByDiscordId.mockResolvedValue({ locale: 'de-DE' });

      await expect(reads.localeFor('d1')).resolves.toBe('de-DE');
    });

    it('defaults to en-US for an unknown user', async () => {
      const { reads, findByDiscordId } = make();
      findByDiscordId.mockResolvedValue(null);

      await expect(reads.localeFor('d1')).resolves.toBe('en-US');
    });

    it('defaults to en-US when locale is null', async () => {
      const { reads, findByDiscordId } = make();
      findByDiscordId.mockResolvedValue({ locale: null });

      await expect(reads.localeFor('d1')).resolves.toBe('en-US');
    });

    it('projects only locale', async () => {
      const { reads, findByDiscordId } = make();
      findByDiscordId.mockResolvedValue(null);

      await reads.localeFor('d1');

      expect(findByDiscordId).toHaveBeenCalledWith('d1', { locale: true });
    });

    it('fails safe to en-US when the read throws (ADR-0021)', async () => {
      const { reads, findByDiscordId } = make();
      findByDiscordId.mockRejectedValue(new Error('db down'));

      await expect(reads.localeFor('d1')).resolves.toBe('en-US');
    });
  });
});
