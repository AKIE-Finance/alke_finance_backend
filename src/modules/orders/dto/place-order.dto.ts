import { IsEnum, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';
import { OrderSide, OrderType } from '@prisma/client';

export class PlaceOrderDto {
  @IsString()
  instrumentId: string;

  @IsEnum(OrderSide)
  side: OrderSide;

  @IsOptional()
  @IsEnum(OrderType)
  orderType?: OrderType;

  @IsNumber()
  @IsPositive()
  quantity: number;

  @IsOptional()
  @IsNumber()
  limitPrice?: number;
}
