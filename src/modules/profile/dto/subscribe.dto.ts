import { IsEnum } from 'class-validator';
import { ProPlan } from '@prisma/client';

export class SubscribeDto {
  @IsEnum(ProPlan)
  plan: ProPlan;
}
