import { Module } from '@nestjs/common';
import { ContactPolicyService } from './contact-policy.service';

@Module({
  providers: [ContactPolicyService],
  exports: [ContactPolicyService],
})
export class ContactPolicyModule {}
