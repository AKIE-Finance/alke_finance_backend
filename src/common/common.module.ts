import { Global, Module, OnModuleInit } from '@nestjs/common';
import { AuditService } from './services/audit.service';
import { EventBus } from './events/event-bus.service';
import { EventsModule } from './events/events.module';
import { FeatureFlagGuard } from './guards/feature-flag.guard';

@Global()
@Module({
  imports: [EventsModule],
  providers: [AuditService, FeatureFlagGuard],
  exports: [AuditService, FeatureFlagGuard],
})
export class CommonModule implements OnModuleInit {
  constructor(private readonly events: EventBus, private readonly audit: AuditService) {}

  /** Blueprint §4.14: the audit log subscribes to every domain event. */
  onModuleInit(): void {
    this.events.subscribe('*', async (event) => {
      await this.audit.recordEvent(event);
    });
  }
}
