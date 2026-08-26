import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PortfolioService } from './portfolio.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('portfolio')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('portfolio')
export class PortfolioController {
  constructor(private portfolio: PortfolioService) {}

  @Get()
  dashboard(@CurrentUser() user: any, @Query('currency') currency?: string) {
    return this.portfolio.dashboard(user.id, currency ?? user.displayCurrency);
  }
}
