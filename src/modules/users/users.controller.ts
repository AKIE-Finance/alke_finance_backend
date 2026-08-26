import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { KycStatus, UserRole } from '@prisma/client';
import { UsersService } from './users.service';
import { BlockUserDto } from './dto/block-user.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('users (admin)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.COMPLIANCE, UserRole.SUPPORT)
@Controller('admin/users')
export class UsersController {
  constructor(private users: UsersService) {}

  @Get()
  list(
    @Query('search') search?: string,
    @Query('kycStatus') kycStatus?: KycStatus,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.users.list({
      search, kycStatus,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.users.detail(id);
  }

  @Roles(UserRole.ADMIN)
  @Patch(':id/block')
  setBlocked(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: BlockUserDto) {
    return this.users.setBlocked(user.id, id, dto);
  }
}
