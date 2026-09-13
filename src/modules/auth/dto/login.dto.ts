import { IsOptional, IsString } from 'class-validator';

export class LoginDto {
  @IsString()
  identifier: string; // e-mail ou téléphone

  @IsString()
  password: string;

  @IsOptional()
  @IsString()
  deviceId?: string;

  @IsOptional()
  @IsString()
  deviceLabel?: string;
}
