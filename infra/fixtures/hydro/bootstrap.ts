// This addon is included only by the local acceptance fixture, never the plugin package.
import { Context, ContestModel, Handler, ForbiddenError } from 'hydrooj';
class FixtureHandler extends Handler {
  noCheckPermView = true;
  async prepare() {
    if (this.request.headers.authorization !== `Bearer ${process.env.CONTEST_CENTER_TOKEN}`)
      throw new ForbiddenError();
  }
  async post() {
    const tid = await ContestModel.add(
      'system',
      'Contest Center local acceptance',
      'Local fixture only',
      1,
      'acm',
      new Date(Date.now() - 3600000),
      new Date(Date.now() + 48 * 3600000),
      [],
      false,
    );
    this.response.body = { contestId: String(tid), domainId: 'system' };
  }
}
export function apply(ctx: Context) {
  ctx.Route('contest_center_fixture', '/contest-center-fixture/create', FixtureHandler);
}
