import { Global, Module } from '@nestjs/common';
import { PolicyService } from './policy.service';

/** Global: brokerage, payments and markets all consult the same guards (§4.13). */
@Global()
@Module({
  providers: [PolicyService],
  exports: [PolicyService],
})
export class PolicyModule {}
