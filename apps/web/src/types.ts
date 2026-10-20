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
export interface ExamSiteView {
  id: string;
  name: string;
  address: string;
  enabled: boolean;
}
export interface ContestView {
  kind: 'ACTIVITY' | 'COMPETITION';
  modules: { admissions: boolean; rooms: boolean; integrations: boolean };
  seatingMode: 'REGISTRATION' | 'PERSON';
  id: string;
  title: string;
  season: string;
  description: string;
  descriptionFormat: 'TEXT' | 'MARKDOWN';
  announcement: string;
  location: string;
  examSites: ExamSiteView[];
  startsAt: string;
  opensAt: string;
  closesAt: string;
  correctionUntil?: string | null;
  publicRosterEnabled: boolean;
  publicRosterReviews: string[];
  published: boolean;
  archived: boolean;
  manuallyClosed: boolean;
  policy: ContestPolicy;
  version: number;
  formVersion: number;
  fields: FieldDefinition[];
  status: 'OPEN' | 'CLOSED' | 'UPCOMING';
  registrationCounts?: { official: number; unofficial: number };
  deletion?: { allowed: boolean; reason: string };
}
export interface PersonView {
  active?: boolean;
  id?: string;
  userId?: string | null;
  name: string;
  email: string;
  captain: boolean;
  confirmed: boolean;
  answers: Data;
}
export interface RegistrationView {
  actions: {
    edit: boolean;
    editOwnMember: boolean;
    submit: boolean;
    withdraw: boolean;
    cancel: boolean;
    delete: boolean;
    review: boolean;
    amendReview: boolean;
    requestFinance: boolean;
    credentials: boolean;
    editReason: string;
  };
  displayState: string;
  reviews: Data[];
  revisions: Data[];
  number: number | null;
  submittedAt: string | null;
  id: string;
  contestId: string;
  contest: ContestView;
  examSiteId: string | null;
  examSite: ExamSiteView | null;
  ownerId: string;
  publicRank: number | null;
  teamName: string;
  teamEnglishName: string;
  participationType: 'OFFICIAL' | 'UNOFFICIAL';
  organization?: { name: string; shortName: string; country: string; icpcId: string } | null;
  invoiceReservedCents: number;
  invoiceIssuedCents: number;
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
