import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { KycStatus, UserRole } from '@prisma/client';
import { KycService } from './kyc.service';
import { SubmitKycDto } from './dto/submit-kyc.dto';
import { ReviewKycDto } from './dto/review-kyc.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('kyc')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('kyc')
export class KycController {
  constructor(private kyc: KycService) {}

  @Post('submissions')
  submit(@CurrentUser() user: any, @Body() dto: SubmitKycDto) {
    return this.kyc.submit(user.id, dto);
  }

  @Get('submissions/me')
  mine(@CurrentUser() user: any) {
    return this.kyc.listMine(user.id);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.COMPLIANCE)
  @Get('submissions')
  listForReview(@Query('status') status?: KycStatus) {
    return this.kyc.listForReview(status);
  }

  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN, UserRole.COMPLIANCE)
  @Post('submissions/:id/review')
  review(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: ReviewKycDto) {
    return this.kyc.review(user.id, id, dto);
  }
}
