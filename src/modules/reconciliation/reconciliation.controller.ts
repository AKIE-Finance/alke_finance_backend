import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ReconciliationState, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types/request-user';
import { ReconciliationService } from './reconciliation.service';
import { UpdateReconciliationDto, WriteOffDto } from './dto/reconciliation.dto';

@ApiTags('admin/reconciliation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.COMPLIANCE)
@Controller('admin')
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Get('reconciliation')
  list(@Query('state') state?: ReconciliationState) {
    return this.reconciliation.list(state);
  }

  @Get('reconciliation/mirror')
  mirror() {
    return this.reconciliation.mirror();
  }

  @Patch('reconciliation/:id')
  update(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: UpdateReconciliationDto) {
    return this.reconciliation.update(id, dto, user.id);
  }

  /** Maker step of a write-off; the checker approves via /admin/approvals. */
  @Post('reconciliation/:id/write-off')
  writeOff(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: WriteOffDto) {
    return this.reconciliation.requestWriteOff(id, dto.reason, user.id);
  }

  @Get('metrics/financial')
  metrics() {
    return this.reconciliation.metrics();
  }
}
