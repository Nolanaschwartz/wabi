jest.mock('pg-boss', () => ({
  PgBoss: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    createQueue: jest.fn(),
    work: jest.fn(),
    schedule: jest.fn(),
    stop: jest.fn(),
  })),
}));

jest.mock('@wabi/shared', () => ({
  prisma: {
    user: { findUnique: jest.fn().mockResolvedValue({ locale: 'en-US' }) },
    escalationEvent: { create: jest.fn().mockResolvedValue({}) },
  },
}));

import { Test } from '@nestjs/testing';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { Listener } from 'necord';
import { EchoController } from '../echo.controller';

describe('EchoController', () => {
  describe('listener registration', () => {
    // necord's explorer discovers listeners by scanning Nest PROVIDERS
    // (DiscoveryService.getProviders()) — never controllers. This test reproduces
    // that exact discovery so it fails if the handler regresses to a controller-only
    // registration (the original bug: the @On listener was never wired to the client).
    it('necord discovers the messageCreate listener from the provider graph', async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [DiscoveryModule],
        providers: [
          {
            provide: EchoController,
            useValue: new EchoController(
              { tripwire: jest.fn() } as any,
              { escalate: jest.fn() } as any,
              { handle: jest.fn() } as any,
            ),
          },
        ],
      }).compile();

      const discovery = moduleRef.get(DiscoveryService);
      const scanner = moduleRef.get(MetadataScanner);
      const reflector = moduleRef.get(Reflector);

      // Mirror NecordExplorerService: only providers are scanned for @On metadata.
      const discovered = discovery
        .getProviders()
        .filter((w) => w.instance && Object.getPrototypeOf(w.instance))
        .flatMap((w) => {
          const proto = Object.getPrototypeOf(w.instance);
          return scanner.getAllMethodNames(proto).map((method) => ({
            cls: w.instance.constructor,
            listener: reflector.get(Listener, (w.instance as any)[method]),
          }));
        })
        .filter((x) => x.listener);

      const messageCreate = discovered.find(
        (x) => x.listener.getEvent() === 'messageCreate',
      );

      expect(messageCreate).toBeDefined();
      expect(messageCreate!.listener.getType()).toBe('on');
      expect(messageCreate!.cls).toBe(EchoController);

      await moduleRef.close();
    });
  });

  describe('handleMessage', () => {
    it('ignores bot messages', async () => {
      const mockTripwire = jest.fn().mockReturnValue(false);
      const mockHandle = jest.fn();

      const controller = new EchoController(
        { tripwire: mockTripwire } as any,
        { escalate: jest.fn() } as any,
        { handle: mockHandle } as any,
      );

      const message = {
        author: { bot: true, id: '123' },
        channel: { isDMBased: () => true },
        content: 'hello',
      } as any;

      await controller.handleMessage([message]);
      expect(mockTripwire).not.toHaveBeenCalled();
      expect(mockHandle).not.toHaveBeenCalled();
    });

    it('ignores non-DM messages', async () => {
      const mockTripwire = jest.fn().mockReturnValue(false);
      const mockHandle = jest.fn();

      const controller = new EchoController(
        { tripwire: mockTripwire } as any,
        { escalate: jest.fn() } as any,
        { handle: mockHandle } as any,
      );

      const message = {
        author: { bot: false, id: '123' },
        channel: { isDMBased: () => false },
        content: 'hello',
      } as any;

      await controller.handleMessage([message]);
      expect(mockTripwire).not.toHaveBeenCalled();
      expect(mockHandle).not.toHaveBeenCalled();
    });

    it('dispatches a real DM to the coaching pipeline', async () => {
      const mockTripwire = jest.fn().mockReturnValue(false);
      const mockHandle = jest.fn();

      const controller = new EchoController(
        { tripwire: mockTripwire } as any,
        { escalate: jest.fn() } as any,
        { handle: mockHandle } as any,
      );

      const message = {
        author: { bot: false, id: '123' },
        channel: { isDMBased: () => true },
        content: 'i played ranked all night',
      } as any;

      await controller.handleMessage([message]);
      expect(mockTripwire).toHaveBeenCalledWith('i played ranked all night');
      expect(mockHandle).toHaveBeenCalledWith(message);
    });

    it('escalates through one seam and cancels a pending coach turn when a tripwire crisis arrives mid-burst', async () => {
      const cancelPending = jest.fn();
      const handle = jest.fn();
      const escalate = jest.fn().mockResolvedValue(undefined);
      const controller = new EchoController(
        { tripwire: jest.fn().mockReturnValue(true) } as any,
        { escalate } as any,
        { handle, cancelPending } as any,
      );

      const message = {
        author: { bot: false, id: '123' },
        channel: { isDMBased: () => true },
        content: 'i want to end it',
        reply: jest.fn().mockResolvedValue({}),
      } as any;

      await controller.handleMessage([message]);

      // Pending coach turn is canceled (no cheerful reply), and we don't run the coach pipeline.
      expect(cancelPending).toHaveBeenCalledWith('123');
      expect(handle).not.toHaveBeenCalled();
      // The whole crisis response goes through the single Escalation seam, tagged 'tripwire'.
      expect(escalate).toHaveBeenCalledTimes(1);
      expect(escalate).toHaveBeenCalledWith(message, 'tripwire');
    });
  });
});
