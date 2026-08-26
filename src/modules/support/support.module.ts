import { Module } from '@nestjs/common';
import { SupportService } from './support.service';
import { SupportController } from './support.controller';

@Module({
  providers: [SupportService],
  controllers: [SupportController],
})
export class SupportModule {}
