import { Module } from '@nestjs/common';
import { EchoController } from './echo.controller';
import { CrisisModule } from '../crisis/crisis.module';

@Module({
  controllers: [EchoController],
  imports: [CrisisModule],
})
export class EchoModule {}
