import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KycService } from './kyc.service';
import { KycController } from './kyc.controller';
import { KycAdminController } from './kyc-admin.controller';
import { BrokerAccountsService } from './broker-accounts.service';
import { BrokerAccountsController } from './broker-accounts.controller';
import { KYC_PROVIDER } from './kyc.types';
import { SimulatedKycProvider } from './providers/simulated-kyc.provider';
import { SmileIdProvider } from './providers/smile-id.provider';

/**
 * Dépend des modules globaux PrismaModule, EventsModule, CommonModule,
 * ConfigValuesModule, ApprovalsModule et StorageModule. Le fournisseur est
 * choisi par KYC_MODE (simulated | smileid, validé par env.validation).
 */
@Module({
  providers: [
    KycService,
    BrokerAccountsService,
    SimulatedKycProvider,
    SmileIdProvider,
    {
      provide: KYC_PROVIDER,
      inject: [ConfigService, SimulatedKycProvider, SmileIdProvider],
      useFactory: (config: ConfigService, simulated: SimulatedKycProvider, smile: SmileIdProvider) =>
        config.get<string>('KYC_MODE') === 'smileid' ? smile : simulated,
    },
  ],
  controllers: [KycController, KycAdminController, BrokerAccountsController],
  exports: [KycService, BrokerAccountsService],
})
export class KycModule {}
