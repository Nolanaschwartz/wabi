import { SessionBufferService } from '../session-buffer.service';

describe('SessionBufferService', () => {
  let service: SessionBufferService;

  beforeEach(() => {
    service = new SessionBufferService();
    service.init = jest.fn().mockResolvedValue(undefined);
  });

  describe('init() resilience (bot must come online even if Redis is down)', () => {
    let svc: SessionBufferService;
    beforeEach(() => {
      svc = new SessionBufferService();
    });

    it('resolves without throwing when Redis connect rejects', async () => {
      (svc as any).client = {
        on: jest.fn(),
        connect: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      };

      await expect(svc.init()).resolves.toBeUndefined();
    });

    it('does not block bootstrap when Redis connect hangs', async () => {
      jest.useFakeTimers();
      (svc as any).client = {
        on: jest.fn(),
        connect: jest.fn(() => new Promise(() => {})), // never resolves
      };

      const p = svc.init();
      await jest.advanceTimersByTimeAsync(10_000);

      await expect(p).resolves.toBeUndefined();
      jest.useRealTimers();
    });

    it('attaches an error handler so a dropped connection never crashes the process', async () => {
      const on = jest.fn();
      (svc as any).client = { on, connect: jest.fn().mockResolvedValue(undefined) };

      await svc.init();

      expect(on).toHaveBeenCalledWith('error', expect.any(Function));
    });
  });

  it('creates new session with unique sessionId', async () => {
    jest.spyOn(service as any, 'getRaw').mockResolvedValue(null);
    jest.spyOn(service as any, 'sessionKey').mockReturnValue('wabi:sess:123');

    const mockClient = {
      hSet: jest.fn().mockResolvedValue(true),
      connect: jest.fn().mockResolvedValue(undefined),
      quit: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
    };
    (service as any).client = mockClient;

    await service.append('123', 'user', 'hello');
    expect(mockClient.hSet).toHaveBeenCalled();
  });

  it('generates new sessionId on first append', async () => {
    jest.spyOn(service as any, 'getRaw').mockResolvedValue(null);

    const mockClient = {
      hSet: jest.fn().mockResolvedValue(true),
    };
    (service as any).client = mockClient;

    await service.append('123', 'user', 'hello');

    const call = mockClient.hSet.mock.calls[0];
    const data = call[1];
    expect(data.sessionId).toBeDefined();
  });

  it('does NOT set self-expiring TTL (sweeper-driven expiry)', async () => {
    jest.spyOn(service as any, 'getRaw').mockResolvedValue(null);

    const mockClient = {
      hSet: jest.fn().mockResolvedValue(true),
      expire: jest.fn().mockResolvedValue(true),
    };
    (service as any).client = mockClient;

    await service.append('123', 'user', 'hello');

    expect(mockClient.hSet).toHaveBeenCalled();
    expect(mockClient.expire).not.toHaveBeenCalled();
  });

  it('clearAndQuarantine deletes session and sets quarantine flag', async () => {
    const mockClient = {
      del: jest.fn().mockResolvedValue(1),
      set: jest.fn().mockResolvedValue('OK'),
    };
    (service as any).client = mockClient;

    await service.clearAndQuarantine('123');

    expect(mockClient.del).toHaveBeenCalledWith('wabi:sess:123');
    expect(mockClient.set).toHaveBeenCalledWith(
      'wabi:quarantine:123',
      'true',
      expect.objectContaining({ EX: 86400 }),
    );
  });

  describe('inAftermathWindow (raw quarantine-key read; policy stays in CrisisAftermath)', () => {
    it('returns true when the quarantine key is set', async () => {
      const mockClient = { get: jest.fn().mockResolvedValue('true') };
      (service as any).client = mockClient;

      await expect(service.inAftermathWindow('123')).resolves.toBe(true);
      expect(mockClient.get).toHaveBeenCalledWith('wabi:quarantine:123');
    });

    it('returns false when the quarantine key is absent', async () => {
      const mockClient = { get: jest.fn().mockResolvedValue(null) };
      (service as any).client = mockClient;

      await expect(service.inAftermathWindow('123')).resolves.toBe(false);
    });
  });
});
