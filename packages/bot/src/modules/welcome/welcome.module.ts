import { Module } from '@nestjs/common';
import { WelcomeService } from './welcome.service';
import { WelcomeController } from './welcome.controller';
import { UserModule } from '../user/user.module';

@Module({
  imports: [UserModule],
  providers: [WelcomeService, WelcomeController],
  exports: [WelcomeService],
})
export class WelcomeModule {}
