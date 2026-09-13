import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PaymentDirection, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaymentsService } from './payments.service';
import { CreateDepositDto } from './dto/create-deposit.dto';
import { RequestWithdrawalDto } from './dto/request-withdrawal.dto';

interface AuthenticatedUser {
  id: string;
  role: UserRole;
}

/** Replaces the former wallet module: balances come from the ledger, movements are PaymentIntents. */
@ApiTags('wallet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('wallet')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  wallet(@CurrentUser() user: AuthenticatedUser) {
    return this.payments.wallet(user.id);
  }

  @Post('deposits')
  async deposit(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateDepositDto) {
    const { intent, paymentUrl } = await this.payments.createDeposit(user.id, dto);
    return { ...PaymentsService.intentToApi(intent), paymentUrl: paymentUrl ?? null };
  }

  @Get('deposits/:id')
  async deposit_(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return PaymentsService.intentToApi(await this.payments.getIntentForUser(user.id, id));
  }

  @Post('withdrawals')
  async withdraw(@CurrentUser() user: AuthenticatedUser, @Body() dto: RequestWithdrawalDto) {
    return PaymentsService.intentToApi(await this.payments.requestWithdrawal(user.id, dto));
  }

  @Get('transactions')
  transactions(@CurrentUser() user: AuthenticatedUser, @Query('currency') currency?: string, @Query('limit') limit?: string) {
    return this.payments.transactions(user.id, currency, limit ? Number(limit) : undefined);
  }

  @Get('intents')
  async intents(@CurrentUser() user: AuthenticatedUser, @Query('direction') direction?: string) {
    const dir = direction === 'IN' || direction === 'OUT' ? (direction as PaymentDirection) : undefined;
    return (await this.payments.listIntents(user.id, dir)).map(PaymentsService.intentToApi);
  }

  // -------------------------------------------------------------- back-office

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('admin/pending')
  async adminPending() {
    return (await this.payments.adminListPending()).map((i) => ({ ...PaymentsService.intentToApi(i), user: i.user }));
  }

  /**
   * Re-queries the provider. Crediting without provider confirmation is only
   * possible through the maker-checker action PAYMENT_FORCE_COMPLETE
   * (approvals module → PaymentsService.forceComplete).
   */
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('admin/:id/recheck')
  async adminRecheck(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return PaymentsService.intentToApi(await this.payments.adminRecheck(user.id, id));
  }
}
