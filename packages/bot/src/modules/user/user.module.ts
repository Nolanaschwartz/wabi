import { Module } from '@nestjs/common';
import { UserService } from './user.service';
import { AccountReads } from './account-reads.service';

@Module({
  providers: [UserService, AccountReads],
  exports: [UserService, AccountReads],
})
export class UserModule {}
