import { Body, Controller, Get, Param, Post, Query, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PaymentDirection, PaymentIntentState, UserRole } from '@prisma/client';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types/request-user';
import { APPROVALS_PORT, ApprovalsPort } from '../approvals/approvals.types';
import { PaymentsService } from './payments.service';

export class ForceCompleteDto {
  @IsString()
  @MinLength(5, { message: 'Un motif d’au moins 5 caractères est requis.' })
  @MaxLength(1000)
  reason!: string;
}

function asEnum<T extends string>(values: readonly T[], v?: string): T | undefined {
  return v && (values as readonly string[]).includes(v) ? (v as T) : undefined;
}

/**
 * Blueprint §4.20 aliases of the back-office routes kept on /wallet/admin/*.
 * Forcing a payment never happens here directly: it opens a
 * PAYMENT_FORCE_COMPLETE maker-checker request (executor in approvals).
 */
@ApiTags('admin / paiements')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.COMPLIANCE)
@Controller('admin/payments')
export class PaymentsAdminController {
  constructor(private readonly payments: PaymentsService, private readonly moduleRef: ModuleRef) {}

  /** ApprovalsModule is global but not a declared dependency of PaymentsModule: resolve it lazily. */
  private approvals(): ApprovalsPort {
    try {
      return this.moduleRef.get<ApprovalsPort>(APPROVALS_PORT, { strict: false });
    } catch {
      throw new ServiceUnavailableException('Le module de validation (maker-checker) n’est pas chargé.');
    }
  }

  @Get('intents')
  async intents(@Query('state') state?: string, @Query('direction') direction?: string) {
    const rows = await this.payments.adminListIntents({
      state: asEnum(Object.values(PaymentIntentState), state),
      direction: asEnum(Object.values(PaymentDirection), direction),
    });
    return rows.map((i) => ({ ...PaymentsService.intentToApi(i), user: i.user }));
  }

  @Roles(UserRole.ADMIN)
  @Post('intents/:id/recheck')
  async recheck(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return PaymentsService.intentToApi(await this.payments.adminRecheck(user.id, id));
  }

  @Roles(UserRole.ADMIN)
  @Post('intents/:id/force-complete')
  async forceComplete(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: ForceCompleteDto) {
    const intent = await this.payments.getIntent(id);
    return this.approvals().request({
      actionType: 'PAYMENT_FORCE_COMPLETE',
      entityType: 'PaymentIntent',
      entityId: intent.id,
      payload: { intentId: intent.id, direction: intent.direction, amount: intent.amount.toFixed(), currency: intent.currency, state: intent.state },
      reason: dto.reason,
      makerId: user.id,
    });
  }
}
