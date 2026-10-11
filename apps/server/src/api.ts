import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
  Inject,
  ForbiddenException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBody } from '@nestjs/swagger';
import { z } from 'zod';
import type { Response, Request } from 'express';
import archiver from 'archiver';
import { AuthService, user, csrf, type AuthRequest } from './auth.js';
import { RegistrationService } from './registrations.js';
import { FinanceService } from './finance.js';
import { SupportService } from './support.js';
import { AdmissionService } from './admissions.js';
import { FileService } from './files.js';
import {
  IntegrationService,
  apiPrincipal,
  apiContest,
  apiRegistration,
  scopedEnvelope,
  scheduleSync,
  verifyCallback,
} from './integrations.js';
import { AdminService } from './admin.js';
import { InvitationService } from './invitations.js';
import { MailService } from './mail.js';
import { db, registrationInclude, json, lock } from './db.js';
import { requireManager, requireAdmin } from './security.js';
import { redis } from './auth.js';

@ApiTags('Contest Center')
@Controller('api/v1')
export class ApiController {
  constructor(
    @Inject(AuthService) private auth: AuthService,
    @Inject(RegistrationService) private registrations: RegistrationService,
    @Inject(FinanceService) private finance: FinanceService,
    @Inject(SupportService) private support: SupportService,
    @Inject(AdmissionService) private admissions: AdmissionService,
    @Inject(FileService) private files: FileService,
    @Inject(IntegrationService) private integrations: IntegrationService,
    @Inject(AdminService) private admin: AdminService,
    @Inject(InvitationService) private invitations: InvitationService,
    @Inject(MailService) private mail: MailService,
  ) {}
  @Get('contests/:id/statistics') statistics(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.registrations.statistics(user(r), id);
  }
  @Get('health') async health() {
    await db.$queryRaw`SELECT 1`;
    await redis.ping();
    return { status: 'ok' };
  }
  @Get('site') site() {
    return this.admin.site();
  }
  @Get('auth/me') me(@Req() r: AuthRequest) {
    return {
      user: r.principal ?? null,
      csrf: csrf(r),
    };
  }
  @Post('auth/register') register(
    @Body() b: unknown,
    @Req() r: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.register(b, r, res);
  }
  @Post('auth/login') login(
    @Body() b: unknown,
    @Req() r: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.auth.login(b, r, res);
  }
  @Post('auth/logout') logout(@Req() r: AuthRequest, @Res({ passthrough: true }) res: Response) {
    return this.auth.logout(r, res);
  }
  @Get('auth/sessions') sessions(@Req() r: AuthRequest) {
    return this.auth.sessions(r);
  }
  @Delete('auth/sessions/:id') revoke(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.auth.revoke(r, id);
  }
  @Post('auth/resend') resend(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.auth.resend(r, b);
  }
  @Post('auth/forgot') forgot(@Body() b: unknown, @Req() r: AuthRequest) {
    return this.auth.forgot(b, r);
  }
  @Post('auth/verify') verify(@Body() b: unknown) {
    return this.auth.consume(b, 'VERIFY');
  }
  @Post('auth/reset') reset(@Body() b: unknown) {
    return this.auth.consume(b, 'RESET');
  }
  @Put('auth/profile') profile(@Body() b: unknown, @Req() r: AuthRequest) {
    return this.auth.profile(r, b);
  }
  @Get('contests') contests(@Req() r: AuthRequest, @Query('all') all?: string) {
    return this.registrations.contests(r.principal, all === 'true');
  }
  @Get('contests/:id') contest(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.registrations.contest(id, r.principal);
  }
  @Post('contests') createContest(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.registrations.saveContest(user(r), undefined, b);
  }
  @Put('contests/:id') saveContest(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.registrations.saveContest(user(r), id, b);
  }
  @Get('registrations') registrationsList(
    @Req() r: AuthRequest,
    @Query('contestId') id?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.registrations.list(user(r), id, cursor);
  }
  @Post('registrations') create(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.registrations.create(user(r), b);
  }
  @Get('registrations/export') async export(
    @Req() r: AuthRequest,
    @Query('contestId') id: string,
    @Res() res: Response,
  ) {
    const u = user(r);
    requireManager(u, id);
    res
      .type('text/csv')
      .setHeader('Content-Disposition', 'attachment; filename="registrations.csv"');
    const csv = (row: unknown[]) =>
      row
        .map(
          (cell) =>
            `"${String(cell)
              .replace(/^[=+\-@\t\r]/, "'$&")
              .replaceAll('"', '""')}"`,
        )
        .join(',') + '\r\n';
    res.write(
      '\uFEFF' +
        csv([
          '报名ID',
          '队名',
          '姓名',
          '邮箱',
          '队长',
          '审核',
          '资格',
          '应收(分)',
          '净到账(分)',
          '自定义字段',
        ]),
    );
    let cursor: string | undefined;
    while (!res.destroyed) {
      const rows = await this.registrations.list(u, id, cursor);
      for (const x of rows)
        for (const p of x.people)
          res.write(
            csv([
              x.id,
              x.teamName,
              p.name,
              p.email,
              p.captain ? '是' : '否',
              x.review,
              x.eligible ? '是' : '否',
              x.feeCents,
              x.netPaidCents,
              JSON.stringify(p.answers),
            ]),
          );
      if (rows.length < 500) break;
      cursor = rows.at(-1)!.id;
    }
    res.end();
  }
  @Get('registrations/:id') detail(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.registrations.detail(user(r), id);
  }
  @Put('registrations/:id') save(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.registrations.save(user(r), id, b);
  }
  @Post('registrations/:id/submit') submit(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.registrations.submit(user(r), id, b);
  }
  @Post('registrations/:id/review') review(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.registrations.review(user(r), id, b);
  }
  @Post('registrations/:id/cancel') cancel(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.registrations.cancel(user(r), id, b);
  }
  @Post('registrations/:id/withdraw') withdraw(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.registrations.withdraw(user(r), id, b);
  }
  @Post('registrations/:id/invites') invite(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.registrations.invite(user(r), id, b);
  }
  @Post('coach/links') coachLink(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.registrations.invite(user(r), undefined, b);
  }
  @Get('invitations/:token') invitation(@Req() r: AuthRequest, @Param('token') token: string) {
    return this.invitations.preview(user(r), token);
  }
  @Post('invitations/:token/accept') accept(
    @Req() r: AuthRequest,
    @Param('token') token: string,
    @Body() b: unknown,
  ) {
    return this.invitations.accept(user(r), token, b);
  }
  @Delete('invitations/:id') revokeInvite(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.invitations.revoke(user(r), id);
  }
  @Delete('registrations/:id/coaches/:coachId') removeCoach(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Param('coachId') c: string,
    @Body() b: unknown,
  ) {
    return this.registrations.removeCoach(user(r), id, c, b);
  }
  @Put('registrations/:id/coaches/:coachId') coachAnswers(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Param('coachId') c: string,
    @Body() b: unknown,
  ) {
    return this.registrations.coachAnswers(user(r), id, c, b);
  }
  @Put('registrations/:id/people/:personId') personAnswers(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Param('personId') p: string,
    @Body() b: unknown,
  ) {
    return this.registrations.personAnswers(user(r), id, p, b);
  }
  @Post('finance/:id/vouchers') voucher(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.finance.voucher(user(r), id, b);
  }
  @Post('finance/vouchers/:id/review') confirm(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.finance.confirm(user(r), id, b);
  }
  @Post('finance/ledger/:id/reverse') reverse(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.finance.reverse(user(r), id, b);
  }
  @Post('finance/:id/refunds') refund(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.finance.requestRefund(user(r), id, b);
  }
  @Post('finance/refunds/:id/review') refundReview(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.finance.refundDecision(user(r), id, b);
  }
  @Post('finance/:id/invoices') invoice(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.finance.invoice(user(r), id, b);
  }
  @Post('finance/invoices/:id/review') invoiceReview(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.finance.invoiceDecision(user(r), id, b);
  }
  @Post('files')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  upload(
    @Req() r: AuthRequest,
    @UploadedFile() file: Express.Multer.File,
    @Query('registrationId') id?: string,
    @Query('ticketId') t?: string,
  ) {
    return this.files.upload(user(r), file, id, t);
  }
  @Get('files/:id') async file(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const f = await this.files.read(user(r), id);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(f.mime).send(f.buffer);
  }
  @Get('support') supportList(@Req() r: AuthRequest) {
    return this.support.list(user(r));
  }
  @Post('support') ticket(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.support.create(user(r), b);
  }
  @Get('support/:id') ticketDetail(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.support.detail(user(r), id);
  }
  @Post('support/:id/messages') reply(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.support.reply(user(r), id, b);
  }
  @Get('admissions/templates') templates(@Req() r: AuthRequest, @Query('contestId') id?: string) {
    return this.admissions.templates(user(r), id);
  }
  @Post('admissions/templates') template(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.admissions.saveTemplate(user(r), b);
  }
  @Post('admissions/preview') preview(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.admissions.preview(user(r), b);
  }
  @Post('admissions/generate') generate(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.admissions.generate(user(r), b);
  }
  @Post('admissions/:id/release') release(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.admissions.release(user(r), id);
  }
  @Get('admissions/batch') async batch(
    @Req() r: AuthRequest,
    @Query('ids') ids: string,
    @Res() res: Response,
  ) {
    const selected = z
      .array(z.string().uuid())
      .min(1)
      .max(200, 'URL 下载每次最多 200 张，更多文档请使用 JSON 批量请求')
      .parse(typeof ids === 'string' ? ids.split(',') : []);
    await this.sendBatch(r, selected, res);
  }
  @Post('admissions/batch') async batchPost(
    @Req() r: AuthRequest,
    @Body() body: unknown,
    @Res() res: Response,
  ) {
    const selection = z
      .array(z.string().uuid())
      .min(1)
      .max(1000, '每次最多下载 1000 张，请分批下载');
    const b = z
      .object({ ids: selection.optional(), registrationIds: selection.optional() })
      .refine((b) => !!b.ids !== !!b.registrationIds, {
        message: '请选择文档 ID 或报名 ID 的其中一种',
      })
      .parse(body);
    const ids = b.ids ?? (await this.admissions.batchDocumentIds(user(r), b.registrationIds!));
    await this.sendBatch(r, ids, res);
  }
  private async sendBatch(r: AuthRequest, ids: string[], res: Response) {
    const documents = [];
    for (const id of new Set(ids))
      documents.push(await this.admissions.downloadLocation(user(r), id));
    res
      .status(200)
      .type('application/zip')
      .setHeader('Content-Disposition', 'attachment; filename="admissions.zip"');
    const zip = archiver('zip');
    zip.on('error', () => res.destroy());
    zip.pipe(res);
    res.once('close', () => zip.abort());
    for (const d of documents) zip.file(d.path, { name: d.name });
    await zip.finalize();
  }
  @Get('admissions/:id/download') async admissionFile(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const d = await this.admissions.download(user(r), id);
    res
      .type('application/pdf')
      .setHeader('Content-Disposition', `attachment; filename="${d.name}"`);
    res.send(d.buffer);
  }
  @Get('jobs/:id') job(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.admissions.job(user(r), id);
  }
  @Get('jobs/:id/download') async jobDownload(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const d = await this.admissions.previewDownload(user(r), id);
    res.type('application/pdf').send(d.buffer);
  }
  @Get('integrations/instances') instances(@Req() r: AuthRequest) {
    return this.integrations.instances(user(r));
  }
  @Post('integrations/instances') instance(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.integrations.instance(user(r), b);
  }
  @Put('integrations/instances/:id') updateInstance(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.integrations.instance(user(r), b, id);
  }
  @Get('integrations/bindings') bindings(@Req() r: AuthRequest, @Query('contestId') id: string) {
    return this.integrations.bindings(user(r), id);
  }
  @Post('integrations/bindings') bind(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.integrations.bind(user(r), b);
  }
  @Post('integrations/bindings/:id/probe') probe(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.integrations.probe(user(r), id);
  }
  @Post('integrations/registrations/:id/sync') sync(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.integrations.sync(user(r), id, b);
  }
  @Get('integrations/registrations/:id/credentials') credentials(
    @Req() r: AuthRequest,
    @Param('id') id: string,
  ) {
    return this.integrations.credentials(user(r), id);
  }
  @Get('admin/jobs') jobs(@Req() r: AuthRequest) {
    return this.integrations.jobs(user(r));
  }
  @Post('admin/jobs/:id/retry') retry(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.integrations.retry(user(r), id);
  }
  @Get('admin/tokens') tokens(@Req() r: AuthRequest) {
    return this.integrations.tokens(user(r));
  }
  @Post('admin/tokens') token(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.integrations.token(user(r), b);
  }
  @Delete('admin/tokens/:id') revokeToken(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.integrations.revokeToken(user(r), id);
  }
  @Post('admin/webhooks') webhook(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.integrations.webhook(user(r), b);
  }
  @Get('admin/users') users(@Req() r: AuthRequest) {
    return this.admin.users(user(r));
  }
  @Post('admin/roles') role(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.invitations.role(user(r), b);
  }
  @Get('admin/invitations') authorizationInvitations(@Req() r: AuthRequest) {
    return this.invitations.list(user(r));
  }
  @Post('admin/invitations') createAuthorizationInvitation(
    @Req() r: AuthRequest,
    @Body() b: unknown,
  ) {
    return this.invitations.create(user(r), b);
  }
  @Put('admin/site') saveSite(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.admin.saveSite(user(r), b);
  }
  @Get('admin/mail') mailSettings(@Req() r: AuthRequest) {
    return this.mail.get(user(r));
  }
  @Put('admin/mail') saveMailSettings(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.mail.save(user(r), b);
  }
  @Post('admin/mail/probe') probeMail(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.mail.probe(user(r), b);
  }
  @Post('admin/mail/test') testMail(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.mail.test(user(r), b);
  }
  @Get('admin/mail/tests/:id') mailTestStatus(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.mail.testStatus(user(r), id);
  }
  @Get('admin/fields') fields(@Req() r: AuthRequest) {
    return this.admin.fields(user(r));
  }
  @Post('admin/fields') fieldDefinition(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.admin.field(user(r), b);
  }
  @Get('admin/audit') audit(@Req() r: AuthRequest, @Query('contestId') id?: string) {
    return this.admin.logs(user(r), id);
  }
  @Get('admin/metrics') metrics(@Req() r: AuthRequest) {
    return this.admin.metrics(user(r));
  }
}
@ApiTags('Automation / Federation')
@Controller('api')
export class ExternalController {
  @Get('automation/v1/contests') async contests(@Req() r: Request) {
    const t = await apiPrincipal(r, 'contests:read');
    return db.contest.findMany({
      where: { id: { in: t.contestIds as string[] } },
      select: { id: true, title: true, opensAt: true, closesAt: true, published: true },
    });
  }
  @Get('automation/v1/registrations') async registrations(
    @Req() r: Request,
    @Query('contestId') id?: string,
    @Query('cursor') cursor?: string,
  ) {
    const t = await apiPrincipal(r, 'registrations:read');
    if (id) apiContest(t, id);
    const rows = await db.registration.findMany({
      where: { contestId: id ?? { in: t.contestIds as string[] } },
      include: registrationInclude,
      orderBy: { id: 'asc' },
      take: 500,
      ...(cursor ? { cursor: { id: z.string().uuid().parse(cursor) }, skip: 1 } : {}),
    });
    return rows.map((x) => apiRegistration(x, t.fields as string[]));
  }
  @Get('automation/v1/registrations/:id') async registration(
    @Req() r: Request,
    @Param('id') id: string,
  ) {
    const t = await apiPrincipal(r, 'registrations:read');
    const row = await db.registration.findUniqueOrThrow({
      where: { id },
      include: registrationInclude,
    });
    apiContest(t, row.contestId);
    return apiRegistration(row, t.fields as string[]);
  }
  @Get('automation/v1/finance') async finance(@Req() r: Request, @Query('contestId') id: string) {
    const t = await apiPrincipal(r, 'finance:read');
    apiContest(t, id);
    const data = await db.registration.aggregate({
      where: { contestId: id },
      _sum: { feeCents: true, netPaidCents: true },
      _count: true,
    });
    return {
      contestId: id,
      registrations: data._count,
      receivableCents: data._sum.feeCents ?? 0,
      netReceivedCents: data._sum.netPaidCents ?? 0,
    };
  }
  @Get('automation/v1/support/:id') async ticket(@Req() r: Request, @Param('id') id: string) {
    const t = await apiPrincipal(r, 'support:read');
    const row = await db.supportTicket.findUniqueOrThrow({
      where: { id },
      include: { messages: true },
    });
    if (!row.contestId) throw new ForbiddenException();
    apiContest(t, row.contestId);
    return {
      id: row.id,
      contestId: row.contestId,
      registrationId: row.registrationId,
      title: row.title,
      category: row.category,
      status: row.status,
      version: row.version,
      messages: row.messages.map((m) => ({
        id: m.id,
        createdAt: m.createdAt,
        ...((t.fields as string[]).includes('SUPPORT.text') ? { text: m.text } : {}),
        ...((t.fields as string[]).includes('SUPPORT.attachments')
          ? { attachments: m.attachments }
          : {}),
      })),
    };
  }
  @Get('integration/v1/contests') async federationContests(@Req() r: Request) {
    const t = await apiPrincipal(r, 'integration:read');
    return db.contest.findMany({
      where: { id: { in: t.contestIds as string[] } },
      select: {
        id: true,
        title: true,
        startsAt: true,
        opensAt: true,
        closesAt: true,
        published: true,
      },
    });
  }
  @Get('integration/v1/registrations') async eligible(
    @Req() r: Request,
    @Query('contestId') id: string,
    @Query('cursor') cursor?: string,
  ) {
    const t = await apiPrincipal(r, 'integration:read');
    apiContest(t, id);
    return Promise.all(
      (
        await db.registration.findMany({
          where: { contestId: id, eligible: true },
          include: registrationInclude,
          orderBy: { id: 'asc' },
          take: 500,
          ...(cursor ? { cursor: { id: z.string().uuid().parse(cursor) }, skip: 1 } : {}),
        })
      ).map((row) => scopedEnvelope(row, t.fields as string[])),
    );
  }
  @Post('integration/v1/registrations/:id/provision') async provision(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const t = await apiPrincipal(r, 'integration:write');
    const b = z.object({ bindingId: z.string().uuid() }).parse(body);
    const registration = await db.registration.findUniqueOrThrow({ where: { id } });
    apiContest(t, registration.contestId);
    return db.$transaction((tx) => scheduleSync(tx, id, b.bindingId));
  }
  @Post('integration/v1/registrations/:id/result') async callback(
    @Req() r: Request,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const t = await apiPrincipal(r, 'integration:write');
    const registration = await db.registration.findUniqueOrThrow({ where: { id } });
    apiContest(t, registration.contestId);
    return verifyCallback(id, body);
  }
  @Get('integration/v1/jobs/:id') async result(@Req() r: Request, @Param('id') id: string) {
    const t = await apiPrincipal(r, 'integration:read');
    const j = await db.job.findUniqueOrThrow({ where: { id } });
    if (j.kind !== 'SYNC') throw new ForbiddenException('此接口仅查询平台注册任务');
    const registration = await db.registration.findUniqueOrThrow({ where: { id: j.resourceId } });
    apiContest(t, registration.contestId);
    return { id: j.id, state: j.state, result: j.result, error: j.error };
  }
}
