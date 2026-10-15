import 'reflect-metadata';
import { migrateCancelledRegistrations } from './registration-removal.js';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  Module,
  Catch,
  HttpException,
  type ExceptionFilter,
  type ArgumentsHost,
} from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { config } from './config.js';
import { Idempotency } from './idempotency.js';
import { ApiController, ExternalController } from './api.js';
import { AuthService, attachPrincipal, checkCsrf, type AuthRequest } from './auth.js';
import { RegistrationService } from './registrations.js';
import { SeatingService } from './seating.js';
import { FinanceService } from './finance.js';
import { SupportService } from './support.js';
import { AdmissionService } from './admissions.js';
import { FileService } from './files.js';
import { IntegrationService } from './integrations.js';
import { AdminService } from './admin.js';
import { InvitationService } from './invitations.js';
import { MailService } from './mail.js';
import { GithubService } from './github.js';
import { FeishuService } from './feishu.js';
import { OverviewService } from './overview.js';
import { AuthorizationService } from './authorization.js';
import { PeopleService } from './people.js';
import { StorageService } from './storage.js';
import { MailTemplateService } from './mail-templates.js';
import { PublicRosterService } from './public-roster.js';
import { MailDeliveryService } from './mail-delivery.js';
import { describeApi } from './openapi.js';
import path from 'node:path';
import { defaultSite } from '@contest-center/contracts';
@Catch()
class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    let status = 500,
      message = '服务暂时不可用';
    if (error instanceof HttpException) {
      status = error.getStatus();
      const v = error.getResponse();
      message = typeof v === 'string' ? v : String((v as Record<string, unknown>).message);
    } else if (error instanceof ZodError) {
      status = 400;
      message = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；');
    } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
      status = error.code === 'P2002' ? 409 : error.code === 'P2025' ? 404 : 400;
      message =
        error.code === 'P2002'
          ? '此账号、参赛身份或收款参考号已经存在'
          : error.code === 'P2025'
            ? '记录不存在或已经改变'
            : '操作无法完成';
    }
    if (status === 500)
      console.error('Request failed', error instanceof Error ? error.name : 'unknown');
    res.status(status).json({ statusCode: status, message });
  }
}
@Module({
  controllers: [ApiController, ExternalController],
  providers: [
    AuthService,
    RegistrationService,
    FinanceService,
    SeatingService,
    SupportService,
    AdmissionService,
    FileService,
    IntegrationService,
    AdminService,
    InvitationService,
    MailService,
    GithubService,
    FeishuService,
    OverviewService,
    AuthorizationService,
    PeopleService,
    StorageService,
    MailTemplateService,
    PublicRosterService,
    MailDeliveryService,
  ],
})
class AppModule {}
await migrateCancelledRegistrations();
const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  logger: ['error', 'warn'],
});
app.useBodyParser('json', { limit: '5mb' });
// The production API is private and receives one hop from Caddy.
if (config.production) app.getHttpAdapter().getInstance().set('trust proxy', 1);
app.use(cookieParser());
app.use(async (req: AuthRequest, res: import('express').Response, next: (e?: unknown) => void) => {
  try {
    await attachPrincipal(req);
    await checkCsrf(req);
    next();
  } catch (e) {
    res
      .status(e instanceof HttpException ? e.getStatus() : 500)
      .json({ message: e instanceof HttpException ? e.message : '认证服务暂时不可用' });
  }
});
app.useGlobalFilters(new Errors());
app.useGlobalInterceptors(new Idempotency());
const document = describeApi(
  SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle(defaultSite.name)
      .setVersion('1.0')
      .addCookieAuth('cc_session')
      .addBearerAuth()
      .build(),
  ),
);
SwaggerModule.setup('api/docs', app, document);
if (!config.production) {
  await mkdir(path.join(config.root, 'docs/api'), { recursive: true });
  await writeFile(
    path.join(config.root, 'docs/api/openapi.json'),
    JSON.stringify(document, null, 2),
  );
}
await app.listen(config.port, '0.0.0.0');
console.log(`Contest Center API ready on ${config.port}`);
