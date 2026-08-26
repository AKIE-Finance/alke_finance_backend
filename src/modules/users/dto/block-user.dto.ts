import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class BlockUserDto {
  @IsBoolean()
  isBlocked: boolean;

  @IsOptional()
  @IsString()
  blockedReason?: string;
}
