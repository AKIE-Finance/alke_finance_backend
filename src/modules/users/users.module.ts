import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

/**
 * Dépend des modules globaux PrismaModule, CommonModule (AuditService),
 * ApprovalsModule, LedgerModule (LEDGER_PORT) et StorageModule (DOCUMENT_STORAGE).
 * Enregistre l'exécuteur USER_UNBLOCK.
 */
@Module({
  providers: [UsersService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
