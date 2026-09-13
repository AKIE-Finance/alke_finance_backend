import { IsEnum, IsNumber, IsOptional, IsPositive, IsString, Matches } from 'class-validator';
import { OrderSide, OrderType } from '@prisma/client';

export class PlaceOrderDto {
  @IsString()
  instrumentId!: string;

  @IsEnum(OrderSide)
  side!: OrderSide;

  @IsOptional()
  @IsEnum(OrderType)
  orderType?: OrderType;

  @IsNumber()
  @IsPositive()
  quantity!: number;

  /** DAY (default) or GTD:YYYYMMDD. */
  @IsOptional()
  @Matches(/^(DAY|GTD:\d{8})$/, { message: 'validity doit être DAY ou GTD:YYYYMMDD' })
  validity?: string;
}
