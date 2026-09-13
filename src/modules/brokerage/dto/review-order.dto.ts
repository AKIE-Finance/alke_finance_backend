import { IsEnum, IsNumber, IsOptional, IsPositive, IsString, MinLength } from 'class-validator';
import { OrderStatus } from '@prisma/client';

/** Back-office correction request; applied only after a second approver (maker-checker, ORDER_REVIEW). */
export class ReviewOrderDto {
  @IsEnum(OrderStatus)
  status!: OrderStatus;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  executedPrice?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  executedQuantity?: number;

  @IsOptional()
  @IsString()
  sdbRef?: string;

  @IsString()
  @MinLength(5)
  reason!: string;
}
