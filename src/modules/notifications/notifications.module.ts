import { Module, OnModuleInit } from '@nestjs/common';
import { EventBus } from '../../common/events/event-bus.service';
import { DomainEventName } from '../../common/events/domain-events';
import { NotificationsService } from './notifications.service';
import { NotificationsAdminController } from './notifications-admin.controller';
import { EmailAdapter, InAppAdapter, PushAdapter, SmsAdapter } from './adapters';
import { NOTIFICATION_ADAPTERS } from './notifications.types';

/** User-facing events that carry `payload.userId` and have a template in templates.ts. */
export const USER_NOTIFICATION_EVENTS: readonly DomainEventName[] = [
  'KYCValidated',
  'KYCRejected',
  'KYCManualReview',
  'DepositConfirmed',
  'DepositFailed',
  'WithdrawalPaid',
  'WithdrawalFailed',
  'OrderAcknowledged',
  'OrderRejected',
  'OrderExecuted',
  'OrderPartiallyExecuted',
  'OrderExpired',
  'OrderCancelled',
  'SettlementConfirmed',
];

/**
 * Dépend des modules globaux PrismaModule et EventsModule. Souscrit aux
 * événements utilisateur (blueprint §4.19) et à ApprovalRequested (§4.17).
 */
@Module({
  providers: [
    InAppAdapter,
    SmsAdapter,
    EmailAdapter,
    PushAdapter,
    {
      provide: NOTIFICATION_ADAPTERS,
      inject: [InAppAdapter, SmsAdapter, EmailAdapter, PushAdapter],
      useFactory: (inApp: InAppAdapter, sms: SmsAdapter, email: EmailAdapter, push: PushAdapter) => [inApp, sms, email, push],
    },
    NotificationsService,
  ],
  controllers: [NotificationsAdminController],
  exports: [NotificationsService],
})
export class NotificationsModule implements OnModuleInit {
  constructor(private readonly events: EventBus, private readonly notifications: NotificationsService) {}

  onModuleInit(): void {
    for (const name of USER_NOTIFICATION_EVENTS) {
      this.events.subscribe(name, (e) => this.notifications.onUserEvent(e));
    }
    this.events.subscribe('ApprovalRequested', (e) => this.notifications.onApprovalRequested(e));
  }
}
