import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { LogoutDto } from './dto/logout.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ClientIp } from '../../common/decorators/client-ip.decorator';
import { RequestUser } from '../../common/types/request-user';

/** Blueprint §4.0 : 10 tentatives / minute / IP sur les routes sensibles. */
const SENSITIVE = { default: { limit: 10, ttl: 60_000 } };

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Throttle(SENSITIVE)
  @Post('login')
  login(@Body() dto: LoginDto, @ClientIp() ipAddress?: string, @Headers('user-agent') userAgent?: string) {
    return this.auth.login(dto, { ipAddress, userAgent });
  }

  @Throttle(SENSITIVE)
  @Post('otp/request')
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.auth.requestOtp(dto.destination, dto.purpose);
  }

  @Post('otp/verify')
  verifyOtp(@Body() dto: VerifyOtpDto, @ClientIp() ipAddress?: string, @Headers('user-agent') userAgent?: string) {
    return this.auth.verifyOtp(dto.destination, dto.purpose, dto.code, {
      deviceId: dto.deviceId, deviceLabel: dto.deviceLabel, ipAddress, userAgent,
    });
  }

  @Throttle(SENSITIVE)
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto, @ClientIp() ipAddress?: string, @Headers('user-agent') userAgent?: string) {
    return this.auth.refresh(dto.refreshToken, { ipAddress, userAgent });
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  @Post('logout')
  logout(@CurrentUser() user: RequestUser, @Body() dto: LogoutDto) {
    return this.auth.logout(user.id, dto);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('sessions')
  sessions(@CurrentUser() user: RequestUser) {
    return this.auth.listSessions(user.id);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Delete('sessions/:id')
  revokeSession(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.auth.revokeSession(user.id, id);
  }

  @Throttle(SENSITIVE)
  @Post('password/reset')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.destination, dto.code, dto.newPassword);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post('password/change')
  changePassword(
    @CurrentUser() user: RequestUser,
    @Body() dto: ChangePasswordDto,
    @ClientIp() ipAddress?: string,
    @Headers('user-agent') userAgent?: string,
  ) {
    return this.auth.changePassword(user.id, dto, { ipAddress, userAgent });
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: RequestUser) {
    return this.auth.me(user.id);
  }
}
