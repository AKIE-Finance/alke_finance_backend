import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Liveness and readiness probes for the load balancer, the container
 * HEALTHCHECK and the uptime monitor. No auth, no database write.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: the process is up and serving HTTP. */
  @Get()
  live() {
    return {
      status: 'ok',
      version: process.env.APP_VERSION ?? 'dev',
      env: process.env.APP_ENV ?? 'local',
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  /** Readiness: the database answers. Returns 503 until it does. */
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'up' };
    } catch {
      throw new ServiceUnavailableException({ status: 'error', database: 'down' });
    }
  }
}
