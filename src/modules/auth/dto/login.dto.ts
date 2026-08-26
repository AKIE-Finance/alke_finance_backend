import { IsString } from 'class-validator';

export class LoginDto {
  @IsString()
  identifier: string; // e-mail ou téléphone

  @IsString()
  password: string;
}
