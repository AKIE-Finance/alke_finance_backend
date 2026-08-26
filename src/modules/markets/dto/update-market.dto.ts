import { IsEnum, IsOptional, IsString } from 'class-validator';
import { MarketStatus } from '@prisma/client';

export class UpdateMarketDto {
  @IsOptional()
  @IsEnum(MarketStatus)
  status?: MarketStatus;

  @IsOptional()
  @IsString()
  openingHoursNote?: string;
}
