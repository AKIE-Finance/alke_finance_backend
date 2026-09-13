import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { KycStatus, UserRole } from '@prisma/client';
import { KycService } from './kyc.service';
import { KycDecisionDto } from './dto/decision.dto';
import { ReviewKycDto } from './dto/review-kyc.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types/request-user';

@ApiTags('admin / kyc')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.COMPLIANCE)
@Controller()
export class KycAdminController {
  constructor(private readonly kyc: KycService) {}

  @Get('admin/kyc/queue')
  queue(@Query('status') status?: KycStatus) {
    return this.kyc.queue(status && (Object.values(KycStatus) as string[]).includes(status) ? status : undefined);
  }

  @Get('admin/kyc/cases/:id')
  detail(@Param('id') id: string) {
    return this.kyc.adminCase(id);
  }

  @Post('admin/kyc/cases/:id/decision')
  decide(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: KycDecisionDto) {
    return this.kyc.decide(user.id, id, dto.decision, dto.reason);
  }

  /** Legacy console route: VERIFIED → VALIDATED. */
  @Post('kyc/submissions/:id/review')
  review(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: ReviewKycDto) {
    const decision = dto.status === 'REJECTED' ? KycStatus.REJECTED : KycStatus.VALIDATED;
    return this.kyc.decide(user.id, id, decision, dto.rejectionReason);
  }

  /** Legacy console route: same data as the queue. */
  @Get('kyc/submissions')
  legacyQueue(@Query('status') status?: KycStatus) {
    return this.queue(status);
  }
}
