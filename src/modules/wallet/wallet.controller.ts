import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { WalletService } from './wallet.service';
import { DepositDto } from './dto/deposit.dto';
import { WithdrawDto } from './dto/withdraw.dto';
import { ConvertFxDto } from './dto/convert-fx.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('wallet')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('wallet')
export class WalletController {
  constructor(private wallet: WalletService) {}

  @Get('accounts')
  accounts(@CurrentUser() user: any) {
    return this.wallet.accounts(user.id);
  }

  @Post('deposits')
  deposit(@CurrentUser() user: any, @Body() dto: DepositDto) {
    return this.wallet.deposit(user.id, dto);
  }

  @Post('withdrawals')
  withdraw(@CurrentUser() user: any, @Body() dto: WithdrawDto) {
    return this.wallet.withdraw(user.id, dto);
  }

  @Post('fx/convert')
  convert(@CurrentUser() user: any, @Body() dto: ConvertFxDto) {
    return this.wallet.convertFx(user.id, dto);
  }

  @Get('transactions')
  transactions(@CurrentUser() user: any, @Query('currency') currency?: string) {
    return this.wallet.transactions(user.id, currency);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('admin/pending')
  adminPending() {
    return this.wallet.adminListPending();
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('admin/:id/complete')
  adminComplete(@CurrentUser() user: any, @Param('id') id: string) {
    return this.wallet.adminForceComplete(user.id, id);
  }
}
