import { createHash, timingSafeEqual } from 'node:crypto';
import {
  Context,
  Handler,
  UserModel,
  DomainModel,
  ContestModel,
  ObjectId,
  ForbiddenError,
} from 'hydrooj';
const digest = (v: string) => createHash('sha256').update(v).digest();
const token = process.env.CONTEST_CENTER_TOKEN ?? '';
const domains = (process.env.CONTEST_CENTER_DOMAINS ?? 'system').split(',');
class AuthorizedHandler extends Handler {
  noCheckPermView = true;
  async prepare() {
    const supplied = String(this.request.headers.authorization ?? '').replace(/^Bearer /, '');
    if (token.length < 32 || !timingSafeEqual(digest(supplied), digest(token)))
      throw new ForbiddenError();
  }
}
function parse(args: any) {
  for (const key of ['unrank', 'nickname'])
    if (args[key] !== undefined && typeof args[key] !== 'boolean')
      throw new Error(`${key} must be a boolean`);
  const { username, password, envelope, domainId, contestId } = args;
  if (
    !/^cc_[a-f0-9]{24}$/.test(username) ||
    typeof password !== 'string' ||
    password.length < 16 ||
    envelope?.schemaVersion !== 1 ||
    !domains.includes(domainId) ||
    !ObjectId.isValid(contestId)
  )
    throw new ForbiddenError();
  const nickname =
    envelope.contest?.mode === 'TEAM' ? envelope.teamName : envelope.people?.[0]?.name;
  if (typeof nickname !== 'string' || !nickname.trim() || nickname.length > 200)
    throw new Error('报名昵称无效');
  return {
    username,
    password,
    envelope,
    domainId,
    tid: new ObjectId(contestId),
    nickname,
    nicknameEnabled: args.nickname !== false,
    unrank: args.unrank === true,
  };
}
async function result(args: any) {
  const a = parse(args);
  const user = await UserModel.getByUname(a.domainId, a.username);
  if (!user) throw new Error('Account was not created');
  await user.checkPassword(a.password);
  const status = await ContestModel.getStatus(a.domainId, a.tid, user._id);
  if (
    !status?.attend ||
    status.contestCenterRegistrationId !== a.envelope.registrationId ||
    status.contestCenterSource !== a.envelope.sourceInstance
  )
    throw new Error('Contest linkage was not verified');
  const domainUser = (
    await DomainModel.getMultiUserInDomain(a.domainId, { uid: user._id }).toArray()
  )[0];
  if (
    (a.nicknameEnabled && domainUser?.displayName !== a.nickname) ||
    Boolean(status.unrank) !== a.unrank
  )
    throw new Error('昵称或非正式参赛状态校验失败');
  return {
    schemaVersion: 1,
    registrationId: a.envelope.registrationId,
    state: 'VERIFIED',
    remoteUserId: String(user._id),
    remoteTeamId: String(user._id),
    username: a.username,
    verification: {
      nickname: domainUser?.displayName,
      unrank: Boolean(status.unrank),
      domainId: a.domainId,
      contestId: String(a.tid),
    },
  };
}
class ProbeHandler extends AuthorizedHandler {
  async get() {
    this.response.body = {
      version: '5.0.7',
      pluginVersion: '0.2.1',
      capabilities: [
        'provision',
        'query',
        'independent_team_account',
        'nickname',
        'unofficial',
        'contest_linkage',
      ],
    };
  }
}
class ProvisionHandler extends AuthorizedHandler {
  async post(args: any) {
    const a = parse(args);
    if (!(await ContestModel.get(a.domainId, a.tid)))
      throw new Error('Target contest does not exist');
    let user = await UserModel.getByUname(a.domainId, a.username);
    if (!user) {
      try {
        await UserModel.create(
          `${a.username}@contest-center.invalid`,
          a.username,
          a.password,
          undefined,
          '127.0.0.1',
        );
      } catch (error) {
        if (!(await UserModel.getByUname(a.domainId, a.username))) throw error;
      }
      user = await UserModel.getByUname(a.domainId, a.username);
    }
    if (!user) throw new Error('Account unavailable');
    await user.checkPassword(a.password);
    await DomainModel.setUserRole(a.domainId, user._id, 'default', true);
    const status = await ContestModel.getStatus(a.domainId, a.tid, user._id);
    if (
      status?.attend &&
      (status.contestCenterRegistrationId !== a.envelope.registrationId ||
        status.contestCenterSource !== a.envelope.sourceInstance)
    )
      throw new Error('账号已关联其他报名');
    if (a.nicknameEnabled)
      await DomainModel.setUserInDomain(a.domainId, user._id, { displayName: a.nickname });
    if (!status?.attend) {
      try {
        await ContestModel.attend(a.domainId, a.tid, user._id, {
          contestCenterRegistrationId: a.envelope.registrationId,
          contestCenterSource: a.envelope.sourceInstance,
          unrank: a.unrank,
        });
      } catch (error) {
        if (!(await ContestModel.getStatus(a.domainId, a.tid, user._id))?.attend) throw error;
      }
    }
    await ContestModel.setStatus(a.domainId, a.tid, user._id, { unrank: a.unrank });
    this.response.body = await result(args);
  }
}
class ResultHandler extends AuthorizedHandler {
  async post(args: any) {
    this.response.body = await result(args);
  }
}
export function apply(ctx: Context) {
  ctx.Route('contest_center_probe', '/contest-center/v1/probe', ProbeHandler);
  ctx.Route('contest_center_provision', '/contest-center/v1/provision', ProvisionHandler);
  ctx.Route('contest_center_result', '/contest-center/v1/result', ResultHandler);
}
