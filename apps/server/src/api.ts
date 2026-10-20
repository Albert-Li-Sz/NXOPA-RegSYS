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
  BadRequestException,
} from '@nestjs/common';
import { BoundedUpload } from './upload-interceptor.js';
import { ApiTags, ApiOperation, ApiBody } from '@nestjs/swagger';
import { z } from 'zod';
import type { Response, Request } from 'express';
import archiver from 'archiver';
import { AuthService, user, csrf, type AuthRequest } from './auth.js';
import { RegistrationService } from './registrations.js';
import { removeContest } from './contest-removal.js';
import { registrationCsv } from './registration-export.js';
import { SeatingService } from './seating.js';
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
import { GithubService } from './github.js';
import { FeishuService } from './feishu.js';
import { OverviewService } from './overview.js';
import { AuthorizationService } from './authorization.js';
import { PeopleService } from './people.js';
import { StorageService } from './storage.js';
import { MailTemplateService } from './mail-templates.js';
import { PublicRosterService } from './public-roster.js';
import { MailDeliveryService } from './mail-delivery.js';
import { db, registrationInclude, json, lock, audit } from './db.js';
import { requireManager, requireAdmin } from './security.js';
import { redis } from './auth.js';

@ApiTags('Contest Center')
@Controller('api/v1')
export class ApiController {
  constructor(
    @Inject(AuthService) private auth: AuthService,
    @Inject(RegistrationService) private registrations: RegistrationService,
    @Inject(FinanceService) private finance: FinanceService,
    @Inject(SeatingService) private seating: SeatingService,
    @Inject(SupportService) private support: SupportService,
    @Inject(AdmissionService) private admissions: AdmissionService,
    @Inject(FileService) private files: FileService,
    @Inject(IntegrationService) private integrations: IntegrationService,
    @Inject(AdminService) private admin: AdminService,
    @Inject(InvitationService) private invitations: InvitationService,
    @Inject(MailService) private mail: MailService,
    @Inject(GithubService) private github: GithubService,
    @Inject(FeishuService) private feishu: FeishuService,
    @Inject(OverviewService) private overview: OverviewService,
    @Inject(AuthorizationService) private authorizations: AuthorizationService,
    @Inject(PeopleService) private people: PeopleService,
    @Inject(StorageService) private storage: StorageService,
    @Inject(MailTemplateService) private mailTemplates: MailTemplateService,
    @Inject(PublicRosterService) private publicRoster: PublicRosterService,
    @Inject(MailDeliveryService) private mailDelivery: MailDeliveryService,
  ) {}
  @Get('admin/storage') storageView(@Req() r: AuthRequest) {
    return this.storage.view(user(r));
  }
  @Get('notifications/mail') mailDeliveryStatus(
    @Req() r: AuthRequest,
    @Query('resourceId') id: string,
    @Query() query: Record<string, string>,
  ) {
    return this.mailDelivery.list(user(r), z.string().uuid().parse(id), query);
  }
  @Post('notifications/mail/:id/retry') mailDeliveryRetry(
    @Req() r: AuthRequest,
    @Param('id') id: string,
  ) {
    return this.mailDelivery.retry(user(r), id);
  }
  @Put('admin/storage') storageSave(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.storage.save(user(r), b);
  }
  @Post('admin/storage/test') storageTest(@Req() r: AuthRequest) {
    return this.storage.probe(user(r));
  }
  @Post('admin/storage/migrate') storageMigrate(@Req() r: AuthRequest) {
    return this.storage.migrate(user(r));
  }
  @Get('admin/grants') grants(@Req() r: AuthRequest, @Query('userId') id?: string) {
    return this.authorizations.list(user(r), id);
  }
  @Post('admin/grants') grant(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.authorizations.grant(user(r), b);
  }
  @Delete('admin/grants/:id') revokeGrant(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.authorizations.revoke(user(r), id);
  }
  @Get('admin/students') students(@Req() r: AuthRequest, @Query() q: Record<string, string>) {
    return this.people.students(user(r), q);
  }
  @Get('admin/students/:id') studentDetail(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.people.studentDetail(user(r), id, 'STUDENT');
  }
  @Get('admin/teachers') teachers(@Req() r: AuthRequest, @Query() q: Record<string, string>) {
    return this.people.students(user(r), q, 'TEACHER');
  }
  @Get('admin/teachers/:id') teacherDetail(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.people.studentDetail(user(r), id, 'TEACHER');
  }
  @Get('admin/users/:id') userDetail(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.people.userDetail(user(r), id);
  }
  @Put('admin/users/:id') editUser(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.people.editUser(user(r), id, b);
  }
  @Put('admin/users/:id/ban') banUser(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.people.banUser(user(r), id, b);
  }
  @Delete('admin/users/:id') deleteUser(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.people.deleteUser(user(r), id, b);
  }
  @Get('admin/identities') identities(@Req() r: AuthRequest, @Query() q: Record<string, string>) {
    return this.people.requests(user(r), q);
  }
  @Post('admin/identities/:id/review') identityReview(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.people.reviewIdentity(user(r), id, b);
  }
  @Get('auth/identity') identity(@Req() r: AuthRequest) {
    return this.people.identity(user(r));
  }
  @Delete('auth/grants/:id') resignGrant(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.authorizations.resign(user(r), id);
  }
  @Get('admissions/mine') myAdmissions(@Req() r: AuthRequest) {
    return this.admissions.mine(user(r));
  }
  @Post('auth/identity') identitySubmit(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.people.submitIdentity(user(r), b);
  }
  @Post('auth/verify-code') verifyCode(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.auth.verifyCode(r, b);
  }
  @Post('auth/reset-code') resetCode(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.auth.verifyCode(r, b, 'RESET');
  }
  @Post('auth/closure-code') closureCode(@Req() r: AuthRequest) {
    return this.auth.closureCode(r);
  }
  @Delete('auth/account') closeAccount(@Req() r: AuthRequest, @Body() b: any) {
    return this.people.close(user(r), b, () =>
      this.auth.verifyCode(r, { code: b.code }, 'CLOSE').then(() => undefined),
    );
  }
  @Get('admin/mail/templates') templatesList(@Req() r: AuthRequest) {
    return this.mailTemplates.list(user(r));
  }
  @Post('admin/mail/templates/:key/test') templateTest(
    @Req() r: AuthRequest,
    @Param('key') key: string,
    @Body() b: unknown,
  ) {
    return this.mailTemplates.test(user(r), key, b);
  }
  @Get('admin/mail/templates/tests/:id') templateTestStatus(
    @Req() r: AuthRequest,
    @Param('id') id: string,
  ) {
    return this.mailTemplates.testStatus(user(r), id);
  }
  @Put('admin/mail/templates/:key') templateSave(
    @Req() r: AuthRequest,
    @Param('key') key: string,
    @Body() b: unknown,
  ) {
    return this.mailTemplates.save(user(r), key, b);
  }
  @Get('contests/:id/public-teams') publicTeams(
    @Param('id') id: string,
    @Query() q: Record<string, string>,
  ) {
    return this.publicRoster.list(id, q);
  }
  @Get('contests/:id/public-teams/export') async publicTeamsExport(
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    res
      .type('text/csv; charset=utf-8')
      .setHeader('Content-Disposition', 'attachment; filename="public-teams.csv"')
      .send(await this.publicRoster.csv(id));
  }
  @Put('registrations/:id/public-rank') publicRank(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.publicRoster.rank(user(r), id, b);
  }
  @Get('files') fileList(@Req() r: AuthRequest, @Query() query: Record<string, string>) {
    return this.files.list(user(r), query);
  }
  @Delete('files/:id') fileRemove(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.files.remove(user(r), id);
  }
  @Post('contests/:id/files/distribute') distributeFiles(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.files.distribute(user(r), id, b);
  }
  @Get('files/public/:id') async publicFile(@Param('id') id: string, @Res() res: Response) {
    const file = await this.files.read(null, id);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader(
      'Content-Disposition',
      `${file.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    );
    res.type(file.mime).send(file.buffer);
  }
  @Get('auth/providers') async providers(@Req() r: AuthRequest) {
    return { ...(await this.github.providers(r)), feishu: await this.feishu.provider(r) };
  }
  @Get('overview') overviewStats(@Req() r: AuthRequest, @Query('contestId') id?: string) {
    return this.overview.stats(user(r), id);
  }
  @Get('auth/feishu') feishuStart(@Req() r: AuthRequest, @Res() res: Response) {
    return this.feishu.start(r, res);
  }
  @Get('auth/feishu/callback') feishuCallback(@Req() r: AuthRequest, @Res() res: Response) {
    return this.feishu.callback(r, res);
  }
  @Get('auth/feishu/signup') feishuSignup(@Req() r: AuthRequest) {
    return this.feishu.signupView(r);
  }
  @Delete('auth/feishu') feishuUnlink(@Req() r: AuthRequest) {
    return this.feishu.unlink(r);
  }
  @Get('admin/feishu') feishuSettings(@Req() r: AuthRequest) {
    return this.feishu.view(user(r), r);
  }
  @Put('admin/feishu') feishuSave(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.feishu.save(user(r), r, b);
  }
  @Get('auth/github') githubStart(@Req() r: AuthRequest, @Res() res: Response) {
    return this.github.start(r, res);
  }
  @Get('auth/github/callback') githubCallback(@Req() r: AuthRequest, @Res() res: Response) {
    return this.github.callback(r, res);
  }
  @Delete('auth/github') githubUnlink(@Req() r: AuthRequest) {
    return this.github.unlink(r);
  }
  @Get('admin/github') githubSettings(@Req() r: AuthRequest) {
    return this.github.view(user(r), r);
  }
  @Put('admin/github') githubSave(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.github.save(user(r), r, b);
  }
  @Get('admin/user-tags') userTags(@Req() r: AuthRequest) {
    return this.admin.userTags(user(r));
  }
  @Put('admin/users/:id/tags') tagUser(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.admin.tagUser(user(r), id, b);
  }
  @Get('contests/:id/statistics') statistics(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.registrations.statistics(user(r), id, r.query as Record<string, string>);
  }
  @Get('health') async health() {
    await db.$queryRaw`SELECT 1`;
    await redis.ping();
    return { status: 'ok' };
  }
  @Get('site') site() {
    return this.admin.site();
  }
  @Get('admin/site') siteConfiguration(@Req() r: AuthRequest) {
    return this.admin.siteConfiguration(user(r));
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
  @Post('auth/register/code') registrationCode(@Body() b: unknown, @Req() r: AuthRequest) {
    return this.auth.registrationCode(b, r);
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
  @Get('auth/sessions') sessions(@Req() r: AuthRequest, @Query() query: Record<string, string>) {
    return this.auth.sessions(r, query);
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
  @Post('auth/verify') verify(@Body() b: unknown, @Req() r: AuthRequest) {
    return this.auth.consume(b, 'VERIFY', r);
  }
  @Post('auth/reset') reset(@Body() b: unknown, @Req() r: AuthRequest) {
    return this.auth.consume(b, 'RESET', r);
  }
  @Put('auth/profile') profile(@Body() b: unknown, @Req() r: AuthRequest) {
    return this.auth.profile(r, b);
  }
  @Get('contests') contests(@Req() r: AuthRequest, @Query() query: Record<string, string>) {
    return this.registrations.contests(r.principal, query.all === 'true', query);
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
  @Delete('contests/:id') deleteContest(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return removeContest(user(r), id, b);
  }
  @Get('contests/:id/rooms') rooms(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.seating.view(user(r), id);
  }
  @Post('contests/:id/rooms') createRoom(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.seating.save(user(r), id, undefined, b);
  }
  @Put('contests/:id/rooms/:roomId') saveRoom(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Param('roomId') roomId: string,
    @Body() b: unknown,
  ) {
    return this.seating.save(user(r), id, roomId, b);
  }
  @Delete('contests/:id/rooms/:roomId') deleteRoom(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Param('roomId') roomId: string,
    @Body() b: unknown,
  ) {
    return this.seating.remove(user(r), id, roomId, b);
  }
  @Post('contests/:id/seating/preview') previewSeating(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.seating.plan(user(r), id, b);
  }
  @Post('contests/:id/seating/commit') commitSeating(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.seating.plan(user(r), id, b, true);
  }
  @Post('contests/:id/seating/clear') clearSeating(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.seating.clear(user(r), id, b);
  }
  @Get('integrations/revocations') revocations(
    @Req() r: AuthRequest,
    @Query('contestId') id?: string,
  ) {
    if (id) requireManager(user(r), z.string().uuid().parse(id), 'INTEGRATIONS');
    else requireAdmin(user(r));
    return db.remoteRevocation.findMany({
      where: { contestId: id },
      orderBy: { createdAt: 'desc' },
    });
  }
  @Post('integrations/revocations/:id/complete') async completeRevocation(
    @Req() r: AuthRequest,
    @Param('id') id: string,
  ) {
    return db.$transaction(async (tx) => {
      await lock(tx, `revocation:${id}`);
      const item = await tx.remoteRevocation.findUniqueOrThrow({ where: { id } });
      requireManager(user(r), item.contestId, 'INTEGRATIONS');
      if (item.state === 'COMPLETED') return item;
      const result = await tx.remoteRevocation.update({
        where: { id },
        data: { state: 'COMPLETED', handledBy: user(r).id, completedAt: new Date() },
      });
      await audit(tx, user(r).id, 'REMOTE_REVOCATION_COMPLETE', id, { contestId: item.contestId });
      return result;
    });
  }
  @Get('finance/accounts') financeAccounts(
    @Req() r: AuthRequest,
    @Query() q: Record<string, string>,
  ) {
    return this.finance.accounts(user(r), q);
  }
  @Get('finance/accounts/:id') financeAccount(@Req() r: AuthRequest, @Param('id') id: string) {
    return this.finance.account(user(r), id);
  }
  @Delete('registrations/:id') removeRegistration(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    return this.registrations.remove(user(r), id, b);
  }
  @Get('registrations') registrationsList(
    @Req() r: AuthRequest,
    @Query('contestId') id?: string,
    @Query('cursor') cursor?: string,
    @Query() query: Record<string, string> = {},
  ) {
    return this.registrations.list(user(r), id, cursor, 500, query);
  }
  @Post('registrations') create(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.registrations.create(user(r), b);
  }
  @Get('registrations/review-queue') reviewQueue(
    @Req() r: AuthRequest,
    @Query('contestId') id: string,
    @Query() q: Record<string, string>,
  ) {
    return this.registrations.reviewQueue(user(r), z.string().uuid().parse(id), q);
  }
  @Get('registrations/summary') summary(
    @Req() r: AuthRequest,
    @Query() query: Record<string, string>,
  ) {
    return this.registrations.summary(user(r), query);
  }
  @Get('registrations/export') async export(
    @Req() r: AuthRequest,
    @Query('contestId') id: string,
    @Res() res: Response,
    @Query() query: Record<string, string> = {},
  ) {
    const content = await registrationCsv(
      this.registrations,
      user(r),
      z.string().uuid().parse(id),
      query,
    );
    res
      .type('text/csv')
      .setHeader('Content-Disposition', 'attachment; filename="registrations.csv"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(content);
  }

  @Get('registrations/:id') detail(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Query('history') history?: string,
  ) {
    return this.registrations.detail(user(r), id, history !== 'false');
  }
  @Get('registrations/:id/finance/:collection') financeHistory(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Param('collection') collection: string,
    @Query() query: Record<string, string>,
  ) {
    return this.finance.history(user(r), id, collection, query);
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
  @UseInterceptors(BoundedUpload)
  upload(
    @Req() r: AuthRequest,
    @UploadedFile() file: Express.Multer.File,
    @Query('registrationId') id?: string,
    @Query('ticketId') t?: string,
    @Query('contestId') contestId?: string,
    @Query('purpose') purpose?: string,
  ) {
    return this.files.upload(user(r), file, id, t, { contestId, purpose });
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
  @Get('support') supportList(@Req() r: AuthRequest, @Query() query: Record<string, string>) {
    return this.support.list(user(r), query);
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
    let bytes = 0;
    for (const id of new Set(ids)) {
      const document = await this.admissions.downloadLocation(user(r), id);
      bytes += document.buffer.length;
      if (bytes > 100 * 1024 * 1024)
        throw new BadRequestException('准考证文件总量超过 100 MB，请分批下载');
      documents.push(document);
    }
    res
      .status(200)
      .type('application/zip')
      .setHeader('Content-Disposition', 'attachment; filename="admissions.zip"');
    const zip = archiver('zip');
    zip.on('error', () => res.destroy());
    zip.pipe(res);
    res.once('close', () => zip.abort());
    for (const d of documents) zip.append(d.buffer, { name: d.name });
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
    res
      .type('application/pdf')
      .setHeader('Content-Disposition', 'attachment; filename="preview.pdf"')
      .setHeader('X-Content-Type-Options', 'nosniff')
      .send(d.buffer);
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
  @Post('integrations/bindings/:id/sync') syncExisting(
    @Req() r: AuthRequest,
    @Param('id') id: string,
  ) {
    return this.integrations.syncExisting(user(r), id);
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
  @Get('admin/jobs') jobs(@Req() r: AuthRequest, @Query() query: Record<string, string>) {
    return this.integrations.jobs(user(r), query);
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
  @Get('admin/users') users(@Req() r: AuthRequest, @Query() query: Record<string, string>) {
    return this.admin.users(user(r), query);
  }
  @Post('admin/roles') role(@Req() r: AuthRequest, @Body() b: unknown) {
    return this.invitations.role(user(r), b);
  }
  @Get('admin/invitations') authorizationInvitations(
    @Req() r: AuthRequest,
    @Query() query: Record<string, string>,
  ) {
    return this.invitations.list(user(r), query);
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
  @Get('admin/audit') audit(
    @Req() r: AuthRequest,
    @Query('contestId') id?: string,
    @Query() query: Record<string, string> = {},
  ) {
    return this.admin.logs(user(r), id, query);
  }
  @Get('admin/metrics') metrics(@Req() r: AuthRequest) {
    return this.admin.metrics(user(r));
  }
  @Get('integrations/field-templates') async fieldTemplates(@Req() r: AuthRequest) {
    user(r);
    return (await import('@contest-center/contracts')).platformTemplates;
  }
  @Get('integrations/bindings/:id/metadata') remoteMetadata(
    @Req() r: AuthRequest,
    @Param('id') id: string,
  ) {
    return this.integrations.remoteMetadata(user(r), id);
  }
  @Get('integrations/bindings/:id/schools') schools(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Query() query: Record<string, string>,
  ) {
    return this.integrations.schools(user(r), id, query);
  }
  @Put('integrations/bindings/:id/schools/:schoolId') confirmSchool(
    @Req() r: AuthRequest,
    @Param('id') id: string,
    @Param('schoolId') schoolId: string,
    @Body() b: unknown,
  ) {
    return this.integrations.confirmSchool(user(r), id, schoolId, b);
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
    return db.$transaction(async (tx) => {
      const [active, historical] = await Promise.all([
        tx.registration.aggregate({
          where: { contestId: id },
          _sum: { feeCents: true },
          _count: true,
        }),
        tx.financeAccount.aggregate({
          where: { contestId: id },
          _sum: { netPaidCents: true },
          _count: true,
        }),
      ]);
      return {
        contestId: id,
        registrations: active._count,
        financialAccounts: historical._count,
        receivableCents: active._sum.feeCents ?? 0,
        netReceivedCents: historical._sum.netPaidCents ?? 0,
      };
    });
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
