import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlingModule } from './common/throttling.module';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { HealthModule } from './health/health.module';
import { validateEnv } from './config/env.validation';
import { AuthModule } from './modules/auth/auth.module';
import { KycModule } from './modules/kyc/kyc.module';
import { MarketsModule } from './modules/markets/markets.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ConfigValuesModule } from './modules/config/config-values.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { FeesModule } from './modules/fees/fees.module';
import { BrokerageModule } from './modules/brokerage/brokerage.module';
import { PolicyModule } from './modules/policy/policy.module';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { StorageModule } from './modules/storage/storage.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';
import { UsersModule } from './modules/users/users.module';
import { ProfileModule } from './modules/profile/profile.module';
import { SupportModule } from './modules/support/support.module';
import { AdminModule } from './modules/admin/admin.module';
import { NotificationsModule } from './modules/notifications/notifications.module';

@Module({
  imports: [
    // Fails fast on unsafe configuration (src/config/env.validation.ts).
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ThrottlingModule,
    ScheduleModule.forRoot(),
    PrismaModule,
    CommonModule,
    HealthModule,
    AuthModule,
    KycModule,
    MarketsModule,
    LedgerModule,
    ConfigValuesModule,
    ApprovalsModule,
    PaymentsModule,
    FeesModule,
    PolicyModule,
    ReconciliationModule,
    BrokerageModule,
    StorageModule,
    ComplianceModule,
    PortfolioModule,
    UsersModule,
    ProfileModule,
    SupportModule,
    AdminModule,
    NotificationsModule,
  ],
})
export class AppModule {}
