import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { KycService } from './kyc.service';
import { UpdateKycCaseDto } from './dto/update-case.dto';
import { AddKycDocumentDto } from './dto/add-document.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types/request-user';

@ApiTags('kyc')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Post('case')
  open(@CurrentUser() user: RequestUser) {
    return this.kyc.openCase(user.id);
  }

  @Get('case')
  current(@CurrentUser() user: RequestUser) {
    return this.kyc.myCase(user.id);
  }

  @Patch('case')
  update(@CurrentUser() user: RequestUser, @Body() dto: UpdateKycCaseDto) {
    return this.kyc.updateCase(user.id, dto);
  }

  @Post('case/documents')
  addDocument(@CurrentUser() user: RequestUser, @Body() dto: AddKycDocumentDto) {
    return this.kyc.addDocument(user.id, dto);
  }

  @Post('case/submit')
  submit(@CurrentUser() user: RequestUser) {
    return this.kyc.submit(user.id);
  }

  /** Alias kept for the mobile app contract. */
  @Get('submissions/me')
  mine(@CurrentUser() user: RequestUser) {
    return this.kyc.listMine(user.id);
  }
}
