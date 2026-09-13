import { Global, Module } from '@nestjs/common';
import { ConfigValuesService } from './config-values.service';
import { ConfigAdminController } from './config-admin.controller';

@Global()
@Module({
  providers: [ConfigValuesService],
  controllers: [ConfigAdminController],
  exports: [ConfigValuesService],
})
export class ConfigValuesModule {}
