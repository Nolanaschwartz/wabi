import { SessionBufferService } from '../session-buffer.service';

describe('SessionBufferService', () => {
  let service: SessionBufferService;

  beforeEach(() => {
    service = new SessionBufferService();
    service.init = jest.fn().mockResolvedValue(undefined);
  });

  it('creates new session with unique sessionId', async () => {
    jest.spyOn(service as any, 'getRaw').mockResolvedValue(null);
    jest.spyOn(service as any, 'sessionKey').mockReturnValue('wabi:sess:123');

    const mockClient = {
      hSet: jest.fn().mockResolvedValue(true),
      expire: jest.fn().mockResolvedValue(true),
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
      expire: jest.fn().mockResolvedValue(true),
    };
    (service as any).client = mockClient;

    await service.append('123', 'user', 'hello');

    const call = mockClient.hSet.mock.calls[0];
    const data = call[1];
    expect(data.sessionId).toBeDefined();
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
});
