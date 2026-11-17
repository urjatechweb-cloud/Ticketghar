import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { AppConfig, CONFIG } from '../config';

/**
 * Phase 0 protection for admin and operator endpoints: header x-api-key.
 * Replace with per-operator logins (phone OTP) before onboarding outside operators.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const given = Buffer.from(String(req.headers['x-api-key'] ?? ''));
    const expected = Buffer.from(this.config.adminApiKey);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new UnauthorizedException('missing or wrong x-api-key');
    }
    return true;
  }
}
