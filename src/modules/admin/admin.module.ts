import { Module } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';

/** Dépend des modules globaux PrismaModule et CommonModule (AuditService). */
@Module({
  providers: [AdminService],
  controllers: [AdminController],
})
export class AdminModule {}
