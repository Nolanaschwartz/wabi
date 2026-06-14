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

import { SpokeSessionService, SPOKE_SESSION_TTL_SECONDS } from '../spoke-session.service';

describe('SpokeSessionService', () => {
  let service: SpokeSessionService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SpokeSessionService('redis://localhost:6379');
  });

  // Generalises the journal-only pending-capture floor to a spoke-keyed floor (hub-and-spoke): a spoke
  // that expects a follow-up turn arms the floor with its own name; the next turn is routed straight
  // back to that spoke. Only the spoke NAME is stored — never entry text (ADR-0013), persistence OFF
  // (ADR-0009). Every read fails soft so a degraded Redis can never block the safety/coaching path.

  it('arms the floor for a spoke with a bounded TTL (ephemeral, persistence OFF)', async () => {
    await service.setActive('123', 'journal');

    expect(mockClient.set).toHaveBeenCalledWith('wabi:spokesession:123', 'journal', {
      EX: SPOKE_SESSION_TTL_SECONDS,
    });
  });

  it('reports the active spoke without consuming it (cheap read for the hub router-skip)', async () => {
    mockClient.get.mockResolvedValue('journal');

    expect(await service.active('123')).toBe('journal');
    // A non-consuming read — the marker is not deleted.
    expect(mockClient.del).not.toHaveBeenCalled();
    expect(mockClient.getDel).not.toHaveBeenCalled();
  });

  it('reports no active spoke when the floor is clear (or TTL has expired)', async () => {
    mockClient.get.mockResolvedValue(null);

    expect(await service.active('123')).toBeNull();
  });

  it('consume returns the spoke and atomically clears the floor when armed', async () => {
    mockClient.getDel.mockResolvedValue('journal');

    const spoke = await service.consume('123');

    expect(spoke).toBe('journal');
    expect(mockClient.getDel).toHaveBeenCalledWith('wabi:spokesession:123');
  });

  it('consume returns null when the floor was clear (expired between check and capture)', async () => {
    mockClient.getDel.mockResolvedValue(null);

    expect(await service.consume('123')).toBeNull();
  });

  it('clear drops the floor unconditionally', async () => {
    await service.clear('123');

    expect(mockClient.del).toHaveBeenCalledWith('wabi:spokesession:123');
  });

  it('fails soft to no-active-spoke if the Redis read throws (never blocks the turn)', async () => {
    mockClient.get.mockRejectedValue(new Error('redis down'));

    expect(await service.active('123')).toBeNull();
  });

  it('fails soft to null if consume throws', async () => {
    mockClient.getDel.mockRejectedValue(new Error('redis down'));

    expect(await service.consume('123')).toBeNull();
  });
});
