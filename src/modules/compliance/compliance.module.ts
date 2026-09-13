import { Module, OnModuleInit } from '@nestjs/common';
import { EventBus } from '../../common/events/event-bus.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { KycModule } from '../kyc/kyc.module';
import { ComplianceService } from './compliance.service';
import { ComplianceController } from './compliance.controller';

/**
 * Dépend des modules globaux PrismaModule, EventsModule, CommonModule,
 * ConfigValuesModule, ApprovalsModule ; importe KycModule pour appliquer les
 * décisions KYC passées par maker-checker.
 */
@Module({
  imports: [KycModule],
  providers: [ComplianceService],
  controllers: [ComplianceController],
  exports: [ComplianceService],
})
export class ComplianceModule implements OnModuleInit {
  constructor(
    private readonly events: EventBus,
    private readonly approvals: ApprovalsService,
    private readonly compliance: ComplianceService,
  ) {}

  onModuleInit(): void {
    this.approvals.registerExecutor('COMPLIANCE_DECISION', (a) => this.compliance.executeDecision(a));
    this.events.subscribe('ReconciliationMismatchDetected', (e) => this.compliance.onReconciliationMismatch(e));
    this.events.subscribe('SettlementFailed', (e) => this.compliance.onSettlementFailed(e));
    this.events.subscribe('DepositConfirmed', (e) => this.compliance.onLargeTransaction(e));
    this.events.subscribe('WithdrawalPaid', (e) => this.compliance.onLargeTransaction(e));
    this.events.subscribe('KYCManualReview', (e) => this.compliance.onKycManualReview(e));
  }
}
