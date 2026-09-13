import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentsService } from './payments.service';

/** Every minute: expire deposit intents past their TTL (after a last status query for PENDING ones). */
@Injectable()
export class PaymentsExpiryJob {
  private readonly logger = new Logger(PaymentsExpiryJob.name);
  private running = false;

  constructor(private readonly payments: PaymentsService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { expired, settled } = await this.payments.expireStaleIntents();
      if (expired || settled) this.logger.log(`intents expired=${expired} settled=${settled}`);
    } catch (err) {
      this.logger.error(`expiry job failed: ${(err as Error).message}`, (err as Error).stack);
    } finally {
      this.running = false;
    }
  }
}
