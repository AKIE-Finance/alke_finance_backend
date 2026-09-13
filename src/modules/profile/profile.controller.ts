import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ProfileService } from './profile.service';
import { CreateExternalHoldingDto } from './dto/external-holding.dto';
import { UpdateNotificationPrefDto } from './dto/notification-pref.dto';
import { SubscribeDto } from './dto/subscribe.dto';
import { SubmitNpsDto } from './dto/nps.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { FeatureFlagGuard } from '../../common/guards/feature-flag.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FeatureFlag } from '../../common/decorators/feature-flag.decorator';
import { RequestUser } from '../../common/types/request-user';

/**
 * Fonctions hors périmètre v1.0 (portefeuille externe, parrainage, AlKÉ Pro,
 * NPS) : servies uniquement si FEATURES contient EXTRAS_ENABLED, sinon 404.
 */
const EXTRAS = 'EXTRAS_ENABLED';

@ApiTags('profile')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, FeatureFlagGuard)
@Controller()
export class ProfileController {
  constructor(private profile: ProfileService) {}

  @FeatureFlag(EXTRAS)
  @Get('portfolio/external')
  externalHoldings(@CurrentUser() user: RequestUser) {
    return this.profile.listExternalHoldings(user.id);
  }

  @FeatureFlag(EXTRAS)
  @Post('portfolio/external')
  addExternalHolding(@CurrentUser() user: RequestUser, @Body() dto: CreateExternalHoldingDto) {
    return this.profile.addExternalHolding(user.id, dto);
  }

  @FeatureFlag(EXTRAS)
  @Delete('portfolio/external/:id')
  removeExternalHolding(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.profile.removeExternalHolding(user.id, id);
  }

  @FeatureFlag(EXTRAS)
  @Get('referrals/me')
  myReferrals(@CurrentUser() user: RequestUser) {
    return this.profile.myReferrals(user.id);
  }

  @FeatureFlag(EXTRAS)
  @Get('subscription')
  subscription(@CurrentUser() user: RequestUser) {
    return this.profile.getSubscription(user.id);
  }

  @FeatureFlag(EXTRAS)
  @Post('subscription')
  subscribe(@CurrentUser() user: RequestUser, @Body() dto: SubscribeDto) {
    return this.profile.subscribe(user.id, dto);
  }

  @FeatureFlag(EXTRAS)
  @Post('subscription/cancel')
  cancelSubscription(@CurrentUser() user: RequestUser) {
    return this.profile.cancelSubscription(user.id);
  }

  @Get('notifications/preferences')
  getPrefs(@CurrentUser() user: RequestUser) {
    return this.profile.getPrefs(user.id);
  }

  @Patch('notifications/preferences')
  updatePrefs(@CurrentUser() user: RequestUser, @Body() dto: UpdateNotificationPrefDto) {
    return this.profile.updatePrefs(user.id, dto);
  }

  @Get('notifications')
  listNotifications(@CurrentUser() user: RequestUser) {
    return this.profile.listNotifications(user.id);
  }

  @Patch('notifications/:id/read')
  markRead(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.profile.markNotificationRead(user.id, id);
  }

  @FeatureFlag(EXTRAS)
  @Post('nps')
  submitNps(@CurrentUser() user: RequestUser, @Body() dto: SubmitNpsDto) {
    return this.profile.submitNps(user.id, dto);
  }

  @Get('devices')
  devices(@CurrentUser() user: RequestUser) {
    return this.profile.listDevices(user.id);
  }

  @Delete('devices/:id')
  removeDevice(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.profile.removeDevice(user.id, id);
  }
}
