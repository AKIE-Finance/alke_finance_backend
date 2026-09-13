import { Body, Controller, Get, Header, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { BrokerAccountState, UserRole } from '@prisma/client';
import { BrokerAccountsService } from './broker-accounts.service';
import { UpdateBrokerAccountDto } from './dto/update-broker-account.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types/request-user';

function parseState(state?: string): BrokerAccountState | undefined {
  return state && (Object.values(BrokerAccountState) as string[]).includes(state) ? (state as BrokerAccountState) : undefined;
}

@ApiTags('admin / comptes-titres')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.COMPLIANCE)
@Controller('admin/broker-accounts')
export class BrokerAccountsController {
  constructor(private readonly accounts: BrokerAccountsService) {}

  @Get()
  list(@Query('state') state?: string) {
    return this.accounts.list(parseState(state));
  }

  @Get('export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="broker-accounts.csv"')
  exportCsv(@Query('state') state?: string) {
    return this.accounts.exportCsv(parseState(state) ?? BrokerAccountState.REQUESTED);
  }

  @Roles(UserRole.ADMIN)
  @Patch(':id')
  update(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: UpdateBrokerAccountDto) {
    return this.accounts.update(user.id, id, dto);
  }
}
