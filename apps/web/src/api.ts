import { reactive } from 'vue';
import { ElMessage } from 'element-plus';
import type { Principal } from './types';
import { setClientCsrf } from './generated-client';
import { requestId } from './request-id';
export const auth = reactive<{
  user: Principal | null;
  csrf: string;
  loaded: boolean;
}>({ user: null, csrf: '', loaded: false });
export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const form = body instanceof FormData;
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(form ? {} : { 'Content-Type': 'application/json' }),
      ...(method === 'GET' ? {} : { 'X-CSRF-Token': auth.csrf, 'Idempotency-Key': requestId() }),
    },
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  });
  const content = await response.text();
  let value: any;
  try {
    value = JSON.parse(content);
  } catch {
    const message = `服务暂时不可用（${response.status}），请稍后重试`;
    ElMessage.error(message);
    throw new Error(message);
  }
  if (!response.ok) {
    const message = value.message ?? '请求失败';
    ElMessage.error(message);
    throw new Error(message);
  }
  return value;
}
export async function loadAuth() {
  const data = await api<{ user: Principal | null; csrf: string }>('/auth/me');
  auth.user = data.user;
  auth.csrf = data.csrf;
  setClientCsrf(data.csrf);
  auth.loaded = true;
}
export async function downloadArchive(path: string, body: unknown, name: string) {
  const response = await fetch(`/api/v1${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrf },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ message: '下载失败，请稍后重试' }));
    ElMessage.error(data.message);
    throw new Error(data.message);
  }
  const url = URL.createObjectURL(await response.blob()),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export async function upload(file: File, registrationId?: string, ticketId?: string) {
  const body = new FormData();
  body.append('file', file);
  return api<{ id: string; name: string }>(
    `/files${registrationId ? `?registrationId=${registrationId}` : ticketId ? `?ticketId=${ticketId}` : ''}`,
    'POST',
    body,
  );
}
export const money = (cents: number) => `¥ ${(cents / 100).toFixed(2)}`;
export const date = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
export const shortDate = (value: string) =>
  new Date(value).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }).replaceAll('/', '-');
export const labels: Record<string, string> = {
  OFFICIAL: '正式参赛',
  UNOFFICIAL: '非正式参赛',
  NORMAL: '普通发票',
  SPECIAL: '专用发票',
  ENTERPRISE: '企业',
  ORGANIZATION: '非企业单位',
  WAITING_ORGANIZATION: '等待学校确认',
  NEEDS_CONFIGURATION: '待完善平台配置',
  SKIPPED: '按配置跳过',
  PAYMENT: '确认收款',
  REFUND: '实际退款',
  REVERSAL: '收款冲正',
  RECEIVABLE: '应收费用',
  PERSON: '参赛者',
  TEAM: '队伍',
  COACH: '指导老师',
  REGISTRATION: '报名单',
  text: '短文本',
  textarea: '长文本',
  number: '数字',
  date: '日期',
  select: '单选',
  multiselect: '多选',
  boolean: '开关',
  file: '文件',
  photo: '照片',
  DRAFT: '草稿',
  SUBMITTED: '已提交',
  CORRECTION: '待补正',
  CANCEL_REQUESTED: '取消处理中',
  CANCELLED: '已取消',
  PENDING: '等待审核',
  APPROVED: '审核通过',
  REJECTED: '审核拒绝',
  CONFIRMED: '确认到账',
  REQUESTED: '待处理',
  COMPLETED: '已完成',
  ISSUED: '已开票',
  VOID: '已作废',
  READY: '待发放',
  RELEASED: '已发放',
  OUTBOX: '等待派发',
  TEAM_CREATED: '已创建队伍',
  ACCOUNT_CREATED: '已创建账号',
  QUEUED: '排队中',
  RUNNING: '处理中',
  SUCCESS: '完成',
  FAILED: '失败',
  STALE: '已失效',
  VERIFIED: '联动完成',
  OPEN: '待处理',
  IN_PROGRESS: '处理中',
  WAITING_USER: '待用户补充',
  RESOLVED: '已解决',
  CLOSED: '已关闭',
  REVOKED_LOCALLY: '本站资格已撤销',
};
export const label = (v: string) => labels[v] ?? v;
