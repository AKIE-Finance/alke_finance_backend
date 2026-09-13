import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { OtpService } from './otp.service';
import { JwtStrategy } from './strategies/jwt.strategy';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        // Blueprint §4.10 : jeton d'accès court ; la persistance passe par le refresh token.
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN') || '15m' },
      }),
    }),
  ],
  providers: [AuthService, OtpService, JwtStrategy],
  controllers: [AuthController],
  exports: [AuthService, OtpService],
})
export class AuthModule {}
