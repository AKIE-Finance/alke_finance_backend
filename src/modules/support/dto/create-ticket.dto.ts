import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateTicketDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  subject: string;

  @IsString()
  @MinLength(2)
  @MaxLength(60)
  category: string;

  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  message: string;
}
