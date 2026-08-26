import { IsString } from 'class-validator';

export class AddMessageDto {
  @IsString()
  body: string;
}
