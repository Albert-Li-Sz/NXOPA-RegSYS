import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const get = vi.fn().mockRejectedValue(new Error('reached host API'));
const routes = new Map();
const exported = {};
const source = ts.transpileModule(
  readFileSync(new URL('../../plugins/hydro-contest-center/index.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
vm.runInNewContext(source, {
  exports: exported,
  process: { env: {} },
  Buffer,
  require: (name) =>
    name === 'hydrooj'
      ? {
          Handler: class {},
          ForbiddenError: class extends Error {},
          Context: class {},
          UserModel: {},
          DomainModel: {},
          ContestModel: { get },
          ObjectId: class {
            static isValid() {
              return true;
            }
          },
        }
      : require(name),
});
exported.apply({ Route: (_name, path, Handler) => routes.set(path, Handler) });
const Handler = routes.get('/contest-center/v1/provision');
const input = {
  username: `cc_${'a'.repeat(24)}`,
  password: 'fixture-password-123',
  domainId: 'system',
  contestId: 'a'.repeat(24),
  envelope: { schemaVersion: 1, contest: { mode: 'TEAM' }, teamName: 'Fixture team' },
};
it.each([
  ['unrank', 'true'],
  ['unrank', 1],
  ['nickname', 'false'],
  ['nickname', '张三'],
])('rejects non-boolean %s before touching host state', async (key, value) => {
  get.mockClear();
  await expect(new Handler().post({ ...input, [key]: value })).rejects.toThrow('must be a boolean');
  expect(get).not.toHaveBeenCalled();
});
it('preserves JSON booleans and the default connector request', async () => {
  await expect(new Handler().post(input)).rejects.toThrow('reached host API');
  await expect(new Handler().post({ ...input, unrank: true, nickname: false })).rejects.toThrow(
    'reached host API',
  );
});
