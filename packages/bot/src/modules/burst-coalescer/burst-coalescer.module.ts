import { Module } from '@nestjs/common';
import { BurstCoalescer } from './burst-coalescer.service';

@Module({
  providers: [
    {
      provide: BurstCoalescer,
      useValue: new BurstCoalescer(),
    },
  ],
  exports: [BurstCoalescer],
})
export class BurstCoalescerModule {}
