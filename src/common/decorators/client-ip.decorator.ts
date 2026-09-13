import { createParamDecorator, ExecutionContext } from '@nestjs/common';

type IpRequest = { headers: Record<string, string | string[] | undefined>; ip?: string; socket?: { remoteAddress?: string } };

/** First hop of X-Forwarded-For (set by the reverse proxy), else the socket address. */
export function extractClientIp(req: IpRequest): string | undefined {
  const raw = req.headers['x-forwarded-for'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (header) {
    const first = header.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? req.socket?.remoteAddress ?? undefined;
}

export const ClientIp = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | undefined => {
  return extractClientIp(ctx.switchToHttp().getRequest<IpRequest>());
});
