import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

// Hashing first gives equal-length buffers, which timingSafeEqual requires,
// without revealing the key's length through an early return.
const digest = (value: string) => createHash('sha256').update(value).digest();

@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.OUTREACH_API_KEY?.trim();
    if (!expected) {
      throw new Error('OUTREACH_API_KEY is required.');
    }
    const request = context
      .switchToHttp()
      .getRequest<{ header(name: string): string | undefined }>();
    if (!timingSafeEqual(digest(request.header('x-api-key') ?? ''), digest(expected))) {
      throw new UnauthorizedException('Invalid API key.');
    }
    return true;
  }
}
