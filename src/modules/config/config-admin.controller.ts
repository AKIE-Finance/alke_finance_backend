import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ConfigValuesService } from './config-values.service';

/**
 * Lecture seule. La modification (PUT /admin/config/:key) est câblée par le
 * module approvals : elle crée une PendingApproval CONFIG_CHANGE dont
 * l'exécuteur appelle ConfigValuesService.set().
 */
@ApiTags('admin/config')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.COMPLIANCE)
@Controller('admin/config')
export class ConfigAdminController {
  constructor(private readonly config: ConfigValuesService) {}

  @Get()
  list() {
    return this.config.list();
  }

  @Get(':key')
  async one(@Param('key') key: string) {
    const history = await this.config.history(key);
    const current = await this.config.current(key);
    return { key, current, history };
  }
}
