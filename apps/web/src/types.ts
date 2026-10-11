import type {
  Principal as SharedPrincipal,
  ContestPolicy,
  FieldDefinition as SharedFieldDefinition,
} from '@contest-center/contracts';
export type { ContestPolicy };
export interface FieldDefinition extends Omit<SharedFieldDefinition, 'condition'> {
  condition?: { key: string; equals?: any; includes?: string };
}
export interface Principal extends Omit<SharedPrincipal, 'profile'> {
  profile: Data;
}
export type Data = Record<string, any>;
export interface ContestView {
  id: string;
  title: string;
  season: string;
  description: string;
  announcement: string;
  location: string;
  startsAt: string;
  opensAt: string;
  closesAt: string;
  correctionUntil?: string | null;
  published: boolean;
  archived: boolean;
  manuallyClosed: boolean;
  policy: ContestPolicy;
  version: number;
  formVersion: number;
  fields: FieldDefinition[];
  status: 'OPEN' | 'CLOSED' | 'UPCOMING';
}
export interface PersonView {
  id?: string;
  userId?: string | null;
  name: string;
  email: string;
  captain: boolean;
  confirmed: boolean;
  answers: Data;
}
export interface RegistrationView {
  id: string;
  contestId: string;
  contest: ContestView;
  ownerId: string;
  teamName: string;
  teamEnglishName: string;
  answers: Data;
  status: string;
  review: string;
  reviewReason: string;
  version: number;
  eligible: boolean;
  feeCents: number;
  netPaidCents: number;
  policySnapshot?: ContestPolicy;
  fields: FieldDefinition[];
  formUpdated?: boolean;
  latestFormVersion?: number;
  people: PersonView[];
  coaches: Data[];
  vouchers: Data[];
  ledger: Data[];
  refunds: Data[];
  invoices: Data[];
  admissions: Data[];
  mappings: Data[];
  invitations: Data[];
}
