const mockClient = {
  on: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  set: jest.fn().mockResolvedValue('OK'),
  get: jest.fn(),
  getDel: jest.fn(),
  del: jest.fn().mockResolvedValue(1),
  quit: jest.fn().mockResolvedValue(undefined),
};

jest.mock('redis', () => ({
  createClient: jest.fn(() => mockClient),
}));

import { JournalSessionService, JOURNAL_PENDING_TTL_SECONDS } from '../journal-session.service';

describe('JournalSessionService', () => {
  let service: JournalSessionService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new JournalSessionService('redis://localhost:6379');
  });

  it('sets a pending-journal marker with a bounded TTL (ephemeral, persistence OFF)', async () => {
    await service.setPending('123');

    expect(mockClient.set).toHaveBeenCalledWith(
      'wabi:journalpending:123',
      expect.any(String),
      { EX: JOURNAL_PENDING_TTL_SECONDS },
    );
  });

  it('reports pending without consuming it (cheap read for the router-skip optimisation)', async () => {
    mockClient.get.mockResolvedValue('1');
    expect(await service.isPending('123')).toBe(true);
    // A non-consuming read — the marker is not deleted.
    expect(mockClient.del).not.toHaveBeenCalled();
    expect(mockClient.getDel).not.toHaveBeenCalled();
  });

  it('reports not-pending when no marker is set (or TTL has expired)', async () => {
    mockClient.get.mockResolvedValue(null);
    expect(await service.isPending('123')).toBe(false);
  });

  it('consume returns true and atomically deletes the marker when pending', async () => {
    mockClient.getDel.mockResolvedValue('1');

    const consumed = await service.consume('123');

    expect(consumed).toBe(true);
    expect(mockClient.getDel).toHaveBeenCalledWith('wabi:journalpending:123');
  });

  it('consume returns false when nothing was pending (expired between check and capture)', async () => {
    mockClient.getDel.mockResolvedValue(null);

    expect(await service.consume('123')).toBe(false);
  });

  it('clear deletes the pending marker', async () => {
    await service.clear('123');

    expect(mockClient.del).toHaveBeenCalledWith('wabi:journalpending:123');
  });

  it('fails soft to not-pending if Redis read throws (never blocks the turn)', async () => {
    mockClient.get.mockRejectedValue(new Error('redis down'));
    expect(await service.isPending('123')).toBe(false);
  });
});
