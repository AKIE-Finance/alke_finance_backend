import { IsString, MaxLength, MinLength } from 'class-validator';

export class AddMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body: string;
}
