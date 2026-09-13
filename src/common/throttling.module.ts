import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

/**
 * Global rate limiting: 120 requests / minute / IP by default; sensitive auth
 * routes tighten this with `@Throttle({ default: { limit: 10, ttl: 60000 } })`.
 * Replaces the bare `ThrottlerModule.forRoot(...)` import in AppModule (which
 * configured limits but never registered the guard).
 */
@Module({
  imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }])],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class ThrottlingModule {}
