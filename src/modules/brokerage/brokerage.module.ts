import { Module } from '@nestjs/common';
import { FeesModule } from '../fees/fees.module';
import { FeesService } from '../fees/fees.service';
import { ReconciliationModule } from '../reconciliation/reconciliation.module';
import { FEES_PORT } from './ports';
import { orderConnectorProvider } from './connectors/connector.provider';
import { OrderLedgerService } from './order-ledger.service';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { BatchesService } from './batches.service';
import { BatchesAdminController } from './batches-admin.controller';
import { SettlementService } from './settlement.service';

/**
 * Brokerage (blueprint §4.3, §4.5, §4.15): orders, ORD/WDR batches, ACK/EXE/CSH
 * processing, settlement. Depends on the global LedgerModule, ApprovalsModule,
 * PolicyModule, EventsModule, ConfigValuesModule and PrismaModule; the fee
 * engine is consumed through FEES_PORT (bound here to FeesService).
 */
@Module({
  imports: [FeesModule, ReconciliationModule],
  providers: [
    orderConnectorProvider,
    { provide: FEES_PORT, useExisting: FeesService },
    OrderLedgerService,
    SettlementService,
    BatchesService,
    OrdersService,
  ],
  controllers: [OrdersController, BatchesAdminController],
  exports: [OrdersService, BatchesService, SettlementService, OrderLedgerService],
})
export class BrokerageModule {}
