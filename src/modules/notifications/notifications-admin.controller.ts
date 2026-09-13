import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { NotificationStatus, UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { NotificationsService } from './notifications.service';

@ApiTags('admin / notifications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPPORT)
@Controller('admin/notifications')
export class NotificationsAdminController {
  constructor(private readonly notifications: NotificationsService) {}

  /** Delivery log across every channel (blueprint §4.19). */
  @Get('log')
  log(@Query('status') status?: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    const known = status && (Object.values(NotificationStatus) as string[]).includes(status) ? (status as NotificationStatus) : undefined;
    return this.notifications.listLog({
      status: known,
      page: page === undefined ? undefined : Number(page),
      pageSize: pageSize === undefined ? undefined : Number(pageSize),
    });
  }
}
