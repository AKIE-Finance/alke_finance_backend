import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { FeesService } from './fees.service';
import { UpsertFeeDto } from './dto/upsert-fee.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('fees')
@Controller('fees')
export class FeesController {
  constructor(private fees: FeesService) {}

  @Get()
  list(@Query('marketId') marketId?: string) {
    return this.fees.list(marketId);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post()
  create(@CurrentUser() user: any, @Body() dto: UpsertFeeDto) {
    return this.fees.create(user.id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Delete(':id')
  deactivate(@CurrentUser() user: any, @Param('id') id: string) {
    return this.fees.deactivate(user.id, id);
  }
}
