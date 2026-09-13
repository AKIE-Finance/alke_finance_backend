import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class LogoutDto {
  @IsOptional()
  @IsString()
  refreshToken?: string;

  /** true = révoquer toutes les sessions de l'utilisateur. */
  @IsOptional()
  @IsBoolean()
  all?: boolean;
}
