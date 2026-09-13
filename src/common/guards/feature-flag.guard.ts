import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FEATURE_FLAG_KEY } from '../decorators/feature-flag.decorator';

export function isFeatureEnabled(flag: string, features: string | undefined = process.env.FEATURES): boolean {
  return (features ?? '')
    .split(',')
    .map((f) => f.trim())
    .filter(Boolean)
    .includes(flag);
}

/** Routes behind a disabled flag behave as if they did not exist (404). */
@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const flag = this.reflector.getAllAndOverride<string | undefined>(FEATURE_FLAG_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!flag) return true;
    if (!isFeatureEnabled(flag)) throw new NotFoundException('Fonctionnalité non disponible.');
    return true;
  }
}
