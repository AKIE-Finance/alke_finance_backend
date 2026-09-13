import { BadRequestException, Body, Controller, NotFoundException, Param, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PaymentIntentState, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types/request-user';
import { ApprovalsService } from './approvals.service';
import {
  ConfigChangeRequestDto,
  FeeChangeRequestDto,
  LedgerAdjustmentRequestDto,
  LedgerReversalRequestDto,
  LiveTradingToggleDto,
  PaymentForceCompleteRequestDto,
} from './dto/sensitive-actions.dto';

/**
 * Points d'entrée « maker » : chacun crée une PendingApproval au lieu
 * d'exécuter l'action. L'exécution a lieu dans ApprovalsExecutors après la
 * validation d'un second utilisateur (POST /admin/approvals/:id/approve).
 */
@ApiTags('admin / actions sensibles')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin')
export class SensitiveActionsController {
  constructor(private readonly approvals: ApprovalsService, private readonly prisma: PrismaService) {}

  /** Interrupteur légal (blueprint §4.1) : ne bascule que par maker-checker. */
  @Roles(UserRole.ADMIN)
  @Patch('markets/:id/live-trading')
  async liveTrading(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: LiveTradingToggleDto) {
    const market = await this.prisma.market.findUnique({ where: { id } });
    if (!market) throw new NotFoundException('Marché introuvable.');
    if (market.liveTrading === dto.liveTrading) {
      throw new BadRequestException(`Le marché ${market.code} est déjà ${dto.liveTrading ? 'en trading réel' : 'hors trading réel'}.`);
    }
    return this.approvals.request({
      actionType: 'LIVE_TRADING_TOGGLE',
      entityType: 'Market',
      entityId: id,
      payload: { marketId: id, liveTrading: dto.liveTrading, code: market.code },
      reason: dto.reason,
      makerId: user.id,
    });
  }

  @Roles(UserRole.ADMIN)
  @Post('ledger/adjustments')
  ledgerAdjustment(@CurrentUser() user: RequestUser, @Body() dto: LedgerAdjustmentRequestDto) {
    const total = dto.entries.reduce((acc, e) => acc.plus(e.amount), new Prisma.Decimal(0));
    if (!total.isZero()) throw new BadRequestException('Les écritures d’un ajustement doivent s’équilibrer (somme nulle).');
    const currency = dto.currency.toUpperCase();
    return this.approvals.request({
      actionType: 'LEDGER_ADJUST',
      entityType: 'LedgerTxn',
      payload: {
        currency,
        description: dto.description,
        entries: dto.entries.map((e) => ({ account: { ...e.account }, amount: e.amount })),
      },
      reason: dto.reason,
      makerId: user.id,
    });
  }

  @Roles(UserRole.ADMIN)
  @Post('ledger/reversals')
  async ledgerReversal(@CurrentUser() user: RequestUser, @Body() dto: LedgerReversalRequestDto) {
    const txn = await this.prisma.ledgerTxn.findUnique({ where: { id: dto.txnId } });
    if (!txn) throw new NotFoundException('Transaction introuvable.');
    return this.approvals.request({
      actionType: 'LEDGER_REVERSAL',
      entityType: 'LedgerTxn',
      entityId: dto.txnId,
      payload: { txnId: dto.txnId, reason: dto.reason, type: txn.type, currency: txn.currency },
      reason: dto.reason,
      makerId: user.id,
    });
  }

  /** PUT /admin/config-changes/:key — the read-only /admin/config routes stay in the config module. */
  @Roles(UserRole.ADMIN)
  @Put('config-changes/:key')
  configChange(@CurrentUser() user: RequestUser, @Param('key') key: string, @Body() dto: ConfigChangeRequestDto) {
    if (!/^[a-z0-9_.-]{2,100}$/i.test(key)) throw new BadRequestException('Clé de paramètre invalide.');
    return this.approvals.request({
      actionType: 'CONFIG_CHANGE',
      entityType: 'ConfigValue',
      entityId: key,
      payload: { key, value: dto.value as Prisma.InputJsonValue },
      reason: dto.reason,
      makerId: user.id,
    });
  }

  @Roles(UserRole.ADMIN)
  @Post('fees/changes')
  async feeChange(@CurrentUser() user: RequestUser, @Body() dto: FeeChangeRequestDto) {
    if (dto.marketId) {
      const market = await this.prisma.market.findUnique({ where: { id: dto.marketId } });
      if (!market) throw new NotFoundException('Marché introuvable.');
    }
    const value = new Prisma.Decimal(dto.value);
    if (value.isNegative()) throw new BadRequestException('La valeur d’un frais ne peut pas être négative.');
    if (dto.isPercentage && value.greaterThan(100)) throw new BadRequestException('Un pourcentage ne peut pas dépasser 100.');
    return this.approvals.request({
      actionType: 'FEE_CHANGE',
      entityType: 'FeeSchedule',
      payload: {
        marketId: dto.marketId ?? null,
        feeType: dto.feeType,
        isPercentage: dto.isPercentage,
        value: dto.value,
        minAmount: dto.minAmount ?? null,
        maxAmount: dto.maxAmount ?? null,
        label: dto.label,
      },
      reason: dto.reason,
      makerId: user.id,
    });
  }

  @Roles(UserRole.ADMIN)
  @Post('payments/:intentId/force-complete')
  async paymentForceComplete(
    @CurrentUser() user: RequestUser,
    @Param('intentId') intentId: string,
    @Body() dto: PaymentForceCompleteRequestDto,
  ) {
    const intent = await this.prisma.paymentIntent.findUnique({ where: { id: intentId } });
    if (!intent) throw new NotFoundException('Intention de paiement introuvable.');
    if (intent.state === PaymentIntentState.PAID) throw new BadRequestException('Ce paiement est déjà confirmé.');
    if (intent.state === PaymentIntentState.CANCELLED) throw new BadRequestException('Cette intention a été annulée.');
    return this.approvals.request({
      actionType: 'PAYMENT_FORCE_COMPLETE',
      entityType: 'PaymentIntent',
      entityId: intentId,
      payload: { intentId, direction: intent.direction, amount: intent.amount.toFixed(), currency: intent.currency, userId: intent.userId },
      reason: dto.reason,
      makerId: user.id,
    });
  }
}
