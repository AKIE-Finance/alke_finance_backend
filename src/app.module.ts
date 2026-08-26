import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './modules/auth/auth.module';
import { KycModule } from './modules/kyc/kyc.module';
import { MarketsModule } from './modules/markets/markets.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { FeesModule } from './modules/fees/fees.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PortfolioModule } from './modules/portfolio/portfolio.module';
import { UsersModule } from './modules/users/users.module';
import { ProfileModule } from './modules/profile/profile.module';
import { SupportModule } from './modules/support/support.module';
import { AdminModule } from './modules/admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }]),
    ScheduleModule.forRoot(),
    PrismaModule,
    CommonModule,
    AuthModule,
    KycModule,
    MarketsModule,
    WalletModule,
    FeesModule,
    OrdersModule,
    PortfolioModule,
    UsersModule,
    ProfileModule,
    SupportModule,
    AdminModule,
  ],
})
export class AppModule {}
