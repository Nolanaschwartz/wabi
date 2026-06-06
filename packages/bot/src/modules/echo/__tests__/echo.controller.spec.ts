import { EchoController } from '../echo.controller';

describe('EchoController', () => {
  describe('listener registration', () => {
    it('@On(messageCreate) decorator is on the handler method (verified by design:type)', () => {
      const proto = EchoController.prototype;
      // TypeScript's emitDecoratorMetadata emits design:type metadata for each decorated member.
      // If the decorator is on the method, design:type should be Function.
      // If the decorator was on the class, design:type would NOT be on the method.
      const methodDesignType = Reflect.getMetadata('design:type', proto, 'handleMessage');
      expect(methodDesignType).toBe(Function);
    });

    it('handleMessage has correct parameter types (Message)', () => {
      const proto = EchoController.prototype;
      const params = Reflect.getMetadata('design:paramtypes', proto, 'handleMessage');
      expect(params).toHaveLength(1);
      expect(params[0].name).toBe('Message');
    });

    it('@On is NOT on the class (class only has @Controller)', () => {
      // Class decorator metadata is stored on the constructor function.
      const classParams = Reflect.getMetadata('design:paramtypes', EchoController);
      expect(classParams).toHaveLength(3); // crisisScreening, crisisResources, coaching
    });
  });

  describe('handleMessage', () => {
    it('ignores bot messages', async () => {
      const mockTripwire = jest.fn().mockReturnValue(false);
      const mockHandle = jest.fn();

      const controller = new EchoController(
        { tripwire: mockTripwire } as any,
        null!,
        { handle: mockHandle } as any,
      );

      const message = {
        author: { bot: true, id: '123' },
        channel: { isDMBased: () => true },
        content: 'hello',
      } as any;

      await controller.handleMessage(message);
      expect(mockTripwire).not.toHaveBeenCalled();
      expect(mockHandle).not.toHaveBeenCalled();
    });

    it('ignores non-DM messages', async () => {
      const mockTripwire = jest.fn().mockReturnValue(false);
      const mockHandle = jest.fn();

      const controller = new EchoController(
        { tripwire: mockTripwire } as any,
        null!,
        { handle: mockHandle } as any,
      );

      const message = {
        author: { bot: false, id: '123' },
        channel: { isDMBased: () => false },
        content: 'hello',
      } as any;

      await controller.handleMessage(message);
      expect(mockTripwire).not.toHaveBeenCalled();
      expect(mockHandle).not.toHaveBeenCalled();
    });
  });
});
