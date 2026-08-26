import { IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { OrderStatus } from '@prisma/client';

export class ReviewOrderDto {
  @IsEnum(OrderStatus)
  status: OrderStatus; // TRANSMITTED | PARTIALLY_EXECUTED | EXECUTED | REJECTED | CANCELLED

  @IsOptional()
  @IsNumber()
  executedPrice?: number;

  @IsOptional()
  @IsString()
  partnerReference?: string;

  @IsOptional()
  @IsString()
  rejectionReason?: string;
}
