import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateNotificationPrefDto {
  @IsOptional() @IsBoolean() push?: boolean;
  @IsOptional() @IsBoolean() priceAlerts?: boolean;
  @IsOptional() @IsBoolean() news?: boolean;
  @IsOptional() @IsBoolean() orders?: boolean;
  @IsOptional() @IsBoolean() promo?: boolean;
  @IsOptional() @IsBoolean() community?: boolean;
  @IsOptional() @IsBoolean() email?: boolean;
}
