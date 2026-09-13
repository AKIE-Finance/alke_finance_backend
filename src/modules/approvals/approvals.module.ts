import { Global, Module } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsExecutors } from './approvals-executors.service';
import { SensitiveActionsController } from './sensitive-actions.controller';
import { APPROVALS_PORT } from './approvals.types';

/**
 * Global : tout module possédant une action sensible injecte `ApprovalsService`
 * (ou le jeton `APPROVALS_PORT` pour ne dépendre que de l'interface) et
 * enregistre son exécuteur dans `onModuleInit`.
 *
 * Dépend des modules globaux PrismaModule, EventsModule, CommonModule
 * (AuditService), LedgerModule (LEDGER_PORT) et ConfigValuesModule.
 */
@Global()
@Module({
  providers: [ApprovalsService, ApprovalsExecutors, { provide: APPROVALS_PORT, useExisting: ApprovalsService }],
  controllers: [ApprovalsController, SensitiveActionsController],
  exports: [ApprovalsService, APPROVALS_PORT],
})
export class ApprovalsModule {}
