import { Module } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { WalletController } from './wallet.controller';
import { FxRateService } from './fx-rate.service';

@Module({
  providers: [WalletService, FxRateService],
  controllers: [WalletController],
  exports: [WalletService, FxRateService],
})
export class WalletModule {}
