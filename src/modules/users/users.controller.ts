import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { UsersService } from './users.service';
import { BlockUserDto } from './dto/block-user.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequestUser } from '../../common/types/request-user';

@ApiTags('users (admin)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.COMPLIANCE, UserRole.SUPPORT)
@Controller('admin/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(
    @Query('search') search?: string,
    @Query('kycStatus') kycStatus?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.users.list({
      search,
      kycStatus,
      page: page === undefined ? undefined : Number(page),
      pageSize: pageSize === undefined ? undefined : Number(pageSize),
    });
  }

  @Get(':id')
  detail(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.users.detail(id, user.role);
  }

  /** isBlocked=true applies immediately; isBlocked=false opens a USER_UNBLOCK maker-checker request. */
  @Roles(UserRole.ADMIN)
  @Patch(':id/block')
  setBlocked(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: BlockUserDto) {
    return this.users.setBlocked(user.id, id, dto);
  }
}
