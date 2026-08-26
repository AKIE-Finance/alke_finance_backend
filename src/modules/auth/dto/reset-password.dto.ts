import { IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @IsString()
  destination: string;

  @IsString()
  code: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}
