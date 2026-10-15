import {
  Injectable,
  BadRequestException,
  PayloadTooLargeException,
  ForbiddenException,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
} from '@nestjs/common';
import multer from 'multer';
import { finalize } from 'rxjs';
import { rateLimit, user, type AuthRequest } from './auth.js';

const active = new Map<string, number>();
@Injectable()
export class BoundedUpload implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const response = context.switchToHttp().getResponse();
    const actor = user(request);
    await rateLimit(`uploads:${actor.id}`, 60);
    const key = actor.id;
    if ((active.get(key) ?? 0) >= 2 || (active.get('all') ?? 0) >= 8)
      throw new ForbiddenException('上传繁忙，请等待当前文件上传完成');
    active.set(key, (active.get(key) ?? 0) + 1);
    active.set('all', (active.get('all') ?? 0) + 1);
    const release = () => {
      const n = (active.get(key) ?? 1) - 1;
      if (n) active.set(key, n);
      else active.delete(key);
      active.set('all', (active.get('all') ?? 1) - 1);
    };
    const purpose = String(request.query.purpose ?? 'PRIVATE');
    const size = (purpose === 'AVATAR' ? 5 : purpose === 'PRIVATE' ? 10 : 50) * 1024 * 1024;
    try {
      if (Number(request.headers['content-length']) > size + 65536)
        throw new PayloadTooLargeException('上传文件超过此用途的大小限制');
      await new Promise<void>((resolve, reject) =>
        multer({
          storage: multer.memoryStorage(),
          limits: { fileSize: size, files: 1, fields: 5, fieldSize: 32768 },
        }).single('file')(request, response, (error) => {
          if (error)
            reject(
              error.code === 'LIMIT_FILE_SIZE'
                ? new PayloadTooLargeException('上传文件超过此用途的大小限制')
                : new BadRequestException('上传格式无效或超出限制'),
            );
          else resolve();
        }),
      );
      return next.handle().pipe(finalize(release));
    } catch (error) {
      release();
      throw error;
    }
  }
}
