// Local acceptance helpers only; all imports execute the official Onsite Toolkit.
import {
  Context,
  ContestModel,
  DomainModel,
  UserModel,
  Handler,
  ForbiddenError,
  ObjectId,
} from 'hydrooj';
import * as onsiteToolkit from '@hydrooj/onsite-toolkit';
class AuthenticatedFixture extends Handler {
  noCheckPermView = true;
  async prepare() {
    if (this.request.headers.authorization !== `Bearer ${process.env.CONTEST_CENTER_TOKEN}`)
      throw new ForbiddenError();
  }
}
class FixtureHandler extends AuthenticatedFixture {
  async post() {
    const domainId = `fixture-${Date.now()}`;
    await DomainModel.add(domainId, 1, 'File import acceptance', 'Local only');
    const tid = await ContestModel.add(
      domainId,
      'File import acceptance',
      'Local fixture only',
      1,
      'acm',
      new Date(Date.now() - 3600000),
      new Date(Date.now() + 48 * 3600000),
      [],
      false,
    );
    this.response.body = { contestId: String(tid), domainId };
  }
}
class InspectHandler extends AuthenticatedFixture {
  async post() {
    const { domainId, contestId, usernames } = this.request.body;
    // onsiteImport runs in a separate CLI process. Inspect persisted values,
    // rather than a previous inspection's HTTP-process user cache.
    UserModel.cache.clear();
    this.response.body = await Promise.all(
      usernames.map(async (username: string) => {
        const user = await UserModel.getByUname(domainId, username);
        if (!user) return null;
        const status = await ContestModel.getStatus(domainId, new ObjectId(contestId), user._id);
        return {
          uid: user._id,
          username: user.uname,
          displayName: user.displayName,
          school: user.school,
          members: user.members,
          coach: user.coach,
          seat: user.seat,
          contestMode: user.contestMode,
          attend: status?.attend,
          unrank: status?.unrank,
        };
      }),
    );
  }
}
class PasswordHandler extends AuthenticatedFixture {
  async post() {
    const { domainId, username, password } = this.request.body;
    const user = await UserModel.getByUname(domainId, username);
    if (!user) throw new ForbiddenError();
    await UserModel.setPassword(user._id, password);
    this.response.body = { changed: true };
  }
}
export function apply(ctx: Context) {
  ctx.plugin(onsiteToolkit, {
    extraFields: true,
    contestMode: true,
    ipLogin: false,
    submit: false,
  });
  ctx.Route('contest_center_fixture', '/contest-center-fixture/create', FixtureHandler);
  ctx.Route('contest_center_password', '/contest-center-fixture/password', PasswordHandler);
  ctx.Route('contest_center_inspect', '/contest-center-fixture/inspect', InspectHandler);
}
