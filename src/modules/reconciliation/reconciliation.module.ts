import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { PaymentsService } from '../payments/payments.service';
import { WITHDRAWAL_SETTLEMENT_PORT } from '../brokerage/ports';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationController } from './reconciliation.controller';

/**
 * Depends on the global LedgerModule, ApprovalsModule, PolicyModule, EventsModule
 * and PrismaModule. Withdrawal confirmations from CSH lines are delegated to
 * PaymentsService through WITHDRAWAL_SETTLEMENT_PORT.
 */
@Module({
  imports: [PaymentsModule],
  providers: [ReconciliationService, { provide: WITHDRAWAL_SETTLEMENT_PORT, useExisting: PaymentsService }],
  controllers: [ReconciliationController],
  exports: [ReconciliationService, WITHDRAWAL_SETTLEMENT_PORT],
})
export class ReconciliationModule {}
