import {
  Injectable,
  BadRequestException,
  PayloadTooLargeException,
  ForbiddenException,
  ServiceUnavailableException,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
} from '@nestjs/common';
import multer from 'multer';
import { finalize } from 'rxjs';
import { rateLimit, user, type AuthRequest } from './auth.js';

const active = new Map<string, number>();
// Multer buffers each file in memory, so concurrency is bounded by the bytes
// in flight rather than a fixed number of uploads across the whole site.
const memoryBudget = Number(process.env.UPLOAD_MEMORY_BUDGET_MB ?? 512) * 1024 * 1024;
let reservedBytes = 0;
@Injectable()
export class BoundedUpload implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const response = context.switchToHttp().getResponse();
    const actor = user(request);
    await rateLimit(`uploads:${actor.id}`, 60);
    const key = actor.id;
    const purpose = String(request.query.purpose ?? 'PRIVATE');
    const size = (purpose === 'AVATAR' ? 5 : purpose === 'PRIVATE' ? 10 : 50) * 1024 * 1024;
    const declared = Number(request.headers['content-length']);
    if (declared > size + 65536) throw new PayloadTooLargeException('上传文件超过此用途的大小限制');
    // Chunked bodies have no declared length; reserve the purpose maximum.
    const reserved = Number.isFinite(declared) && declared > 0 ? declared : size + 65536;
    if ((active.get(key) ?? 0) >= 2)
      throw new ForbiddenException('上传繁忙，请等待当前文件上传完成');
    if (reservedBytes && reservedBytes + reserved > memoryBudget)
      throw new ServiceUnavailableException('当前上传人数较多，请稍后重试');
    active.set(key, (active.get(key) ?? 0) + 1);
    reservedBytes += reserved;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      response.off('close', release);
      const n = (active.get(key) ?? 1) - 1;
      if (n) active.set(key, n);
      else active.delete(key);
      reservedBytes -= reserved;
    };
    response.once('close', release);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const aborted = () => finish(new BadRequestException('上传连接已断开'));
        const timer = setTimeout(() => {
          request.destroy();
          finish(new BadRequestException('上传超时，请重试'));
        }, 120000);
        const finish = (error?: any) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.off('aborted', aborted);
          response.off('close', aborted);
          if (error) reject(error);
          else resolve();
        };
        request.once('aborted', aborted);
        response.once('close', aborted);
        multer({
          storage: multer.memoryStorage(),
          limits: { fileSize: size, files: 1, fields: 5, fieldSize: 32768 },
        }).single('file')(request, response, (error) => {
          if (error)
            finish(
              error.code === 'LIMIT_FILE_SIZE'
                ? new PayloadTooLargeException('上传文件超过此用途的大小限制')
                : new BadRequestException('上传格式无效或超出限制'),
            );
          else finish();
        });
      });
      return next.handle().pipe(finalize(release));
    } catch (error) {
      release();
      throw error;
    }
  }
}
