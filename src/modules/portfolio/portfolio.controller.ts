import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PortfolioService } from './portfolio.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types/request-user';

@ApiTags('portfolio')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('portfolio')
export class PortfolioController {
  constructor(private readonly portfolio: PortfolioService) {}

  @Get()
  summary(@CurrentUser() user: RequestUser, @Query('currency') currency?: string) {
    return this.portfolio.summary(user.id, currency);
  }

  @Get('positions')
  positions(@CurrentUser() user: RequestUser, @Query('currency') currency?: string) {
    return this.portfolio.positions(user.id, currency);
  }

  @Get('performance')
  performance(@CurrentUser() user: RequestUser, @Query('range') range?: string, @Query('currency') currency?: string) {
    return this.portfolio.performance(user.id, range ? Number(range) : 30, currency);
  }

  @Get('statements/:period')
  statement(@CurrentUser() user: RequestUser, @Param('period') period: string, @Query('currency') currency?: string) {
    return this.portfolio.statement(user.id, period, currency);
  }
}
