import { Module } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { FeesModule } from '../fees/fees.module';
import { WalletModule } from '../wallet/wallet.module';

@Module({
  imports: [FeesModule, WalletModule],
  providers: [OrdersService],
  controllers: [OrdersController],
  exports: [OrdersService],
})
export class OrdersModule {}
