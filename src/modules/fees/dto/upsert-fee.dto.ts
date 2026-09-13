import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Min,
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { FeeType } from '@prisma/client';

/** Un frais en pourcentage ne peut pas dépasser 100 % de l'assiette. */
function MaxWhenPercentage(max: number, options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'maxWhenPercentage',
      target: object.constructor,
      propertyName,
      constraints: [max],
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const dto = args.object as { isPercentage?: boolean };
          if (dto.isPercentage !== true) return true;
          return typeof value === 'number' && value <= (args.constraints[0] as number);
        },
        defaultMessage(args: ValidationArguments): string {
          return `Un frais en pourcentage ne peut pas dépasser ${args.constraints[0]} %.`;
        },
      },
    });
  };
}

export class UpsertFeeDto {
  @IsOptional()
  @IsUUID()
  marketId?: string;

  @IsEnum(FeeType)
  feeType: FeeType;

  @IsBoolean()
  isPercentage: boolean;

  /** Pourcentage (0 < v ≤ 100) si isPercentage, sinon montant fixe positif. */
  @IsNumber()
  @IsPositive({ message: 'La valeur du frais doit être strictement positive.' })
  @MaxWhenPercentage(100)
  value: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  minAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  maxAmount?: number;

  @IsString()
  label: string;
}
