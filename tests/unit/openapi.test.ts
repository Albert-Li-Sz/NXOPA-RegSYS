import { describe, expect, it } from 'vitest';
import { describeApi } from '../../apps/server/src/openapi.js';
describe('generated API contracts', () => {
  it('describes every path parameter and authenticated verification body', () => {
    const document = describeApi({
      openapi: '3.0.0',
      info: { title: 'test', version: '1' },
      paths: {
        '/api/v1/contests/{id}/rooms/{roomId}': { put: { responses: {} } },
        '/api/v1/invitations/{token}/accept': { post: { responses: {} } },
        '/api/v1/auth/verify-code': { post: { responses: {} } },
        '/api/v1/auth/verify': { post: { responses: {} } },
        '/api/v1/contests/{id}/public-teams': { get: { responses: {} } },
        '/api/v1/admin/users/{id}/tags': { put: { responses: {} } },
      },
    });
    const room = document.paths['/api/v1/contests/{id}/rooms/{roomId}']!.put!;
    expect(room.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', in: 'path', required: true }),
        expect.objectContaining({ name: 'roomId', in: 'path', required: true }),
      ]),
    );
    const verification = document.paths['/api/v1/auth/verify-code']!.post!;
    expect(verification.security).toEqual([{ cookie: [] }]);
    expect(verification.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'X-CSRF-Token' })]),
    );
    expect(verification.requestBody).toBeDefined();
    expect(document.paths['/api/v1/auth/verify']!.post!.security).toEqual([]);
    expect(document.paths['/api/v1/contests/{id}/public-teams']!.get!.security).toEqual([]);
    expect(document.paths['/api/v1/admin/users/{id}/tags']!.put!.requestBody).toBeDefined();
  });
});
