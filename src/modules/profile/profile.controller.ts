import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProfileService } from './profile.service';
import { CreateExternalHoldingDto } from './dto/external-holding.dto';
import { UpdateNotificationPrefDto } from './dto/notification-pref.dto';
import { SubscribeDto } from './dto/subscribe.dto';
import { SubmitNpsDto } from './dto/nps.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('profile')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class ProfileController {
  constructor(private profile: ProfileService) {}

  @Get('portfolio/external')
  externalHoldings(@CurrentUser() user: any) {
    return this.profile.listExternalHoldings(user.id);
  }

  @Post('portfolio/external')
  addExternalHolding(@CurrentUser() user: any, @Body() dto: CreateExternalHoldingDto) {
    return this.profile.addExternalHolding(user.id, dto);
  }

  @Delete('portfolio/external/:id')
  removeExternalHolding(@CurrentUser() user: any, @Param('id') id: string) {
    return this.profile.removeExternalHolding(user.id, id);
  }

  @Get('referrals/me')
  myReferrals(@CurrentUser() user: any) {
    return this.profile.myReferrals(user.id);
  }

  @Get('subscription')
  subscription(@CurrentUser() user: any) {
    return this.profile.getSubscription(user.id);
  }

  @Post('subscription')
  subscribe(@CurrentUser() user: any, @Body() dto: SubscribeDto) {
    return this.profile.subscribe(user.id, dto);
  }

  @Post('subscription/cancel')
  cancelSubscription(@CurrentUser() user: any) {
    return this.profile.cancelSubscription(user.id);
  }

  @Get('notifications/preferences')
  getPrefs(@CurrentUser() user: any) {
    return this.profile.getPrefs(user.id);
  }

  @Patch('notifications/preferences')
  updatePrefs(@CurrentUser() user: any, @Body() dto: UpdateNotificationPrefDto) {
    return this.profile.updatePrefs(user.id, dto);
  }

  @Get('notifications')
  listNotifications(@CurrentUser() user: any) {
    return this.profile.listNotifications(user.id);
  }

  @Patch('notifications/:id/read')
  markRead(@CurrentUser() user: any, @Param('id') id: string) {
    return this.profile.markNotificationRead(user.id, id);
  }

  @Post('nps')
  submitNps(@CurrentUser() user: any, @Body() dto: SubmitNpsDto) {
    return this.profile.submitNps(user.id, dto);
  }

  @Get('devices')
  devices(@CurrentUser() user: any) {
    return this.profile.listDevices(user.id);
  }

  @Delete('devices/:id')
  removeDevice(@CurrentUser() user: any, @Param('id') id: string) {
    return this.profile.removeDevice(user.id, id);
  }
}
