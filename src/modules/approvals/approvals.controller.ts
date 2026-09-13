import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ApprovalState, UserRole } from '@prisma/client';
import { ApprovalsService } from './approvals.service';
import { ApproveDto, RejectDto } from './dto/decide-approval.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types/request-user';

@ApiTags('admin / approvals')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.COMPLIANCE)
@Controller('admin/approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  list(@Query('state') state?: ApprovalState, @Query('actionType') actionType?: string) {
    return this.approvals.list({ state, actionType });
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.approvals.getDetail(id);
  }

  @Post(':id/approve')
  approve(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: ApproveDto) {
    return this.approvals.approve(id, user.id, dto.note);
  }

  @Post(':id/reject')
  reject(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: RejectDto) {
    return this.approvals.reject(id, user.id, dto.note);
  }
}
