import createClient from 'openapi-fetch';
import type { paths } from './generated/api';
export const httpClient = createClient<paths>({
  baseUrl: window.location.origin,
  credentials: 'same-origin',
});
let csrfToken = '';
export function setClientCsrf(value: string) {
  csrfToken = value;
}
httpClient.use({
  onRequest({ request }) {
    if (request.method !== 'GET') {
      request.headers.set('X-CSRF-Token', csrfToken);
      request.headers.set('Idempotency-Key', crypto.randomUUID());
    }
    return request;
  },
});
