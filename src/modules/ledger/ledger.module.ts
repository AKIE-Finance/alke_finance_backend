import { Global, Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { LedgerAdminController } from './ledger-admin.controller';
import { LEDGER_PORT } from './ledger.types';

/**
 * Global: every module that moves money injects `LedgerService` (or the
 * `LEDGER_PORT` token for the interface-only dependency).
 */
@Global()
@Module({
  providers: [LedgerService, { provide: LEDGER_PORT, useExisting: LedgerService }],
  controllers: [LedgerAdminController],
  exports: [LedgerService, LEDGER_PORT],
})
export class LedgerModule {}
