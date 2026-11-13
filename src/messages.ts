/**
 * The runtime messages between the extension pages, the content script and
 * the service worker (#3797). Only the service worker holds the data key;
 * every page asks it by message.
 */
import type { CsvPreview, ImportResult } from './import';
import type { DetailField, PersonRecord } from './types';
import type { PasskeyKind } from './vault';

export type Phase = 'setup' | 'locked' | 'unlocked';

export type LockReason = 'idle' | 'pc-locked' | 'manual';

export const AUTO_LOCK_CHOICES = [5, 15, 60, 240] as const;
export type AutoLockMinutes = (typeof AUTO_LOCK_CHOICES)[number];

/** A guarded action needs a check no older than this. */
export const CHECK_WINDOW_MS = 300_000;

/** How long a wrong-password lockout lasts, on the worker and in the popup's own countdown. */
export const PASSWORD_LOCKOUT_MS = 300_000;

export interface Settings {
  autoLockMinutes: AutoLockMinutes;
  lockWhenPcLocks: boolean;
  lastBackupAt: string | null;
}

/** A method as the pages see it: no salt, no wrapped key. */
export interface MethodView {
  id: string;
  type: 'password' | 'passkey' | 'recovery';
  createdAt: string;
  kind?: PasskeyKind;
  name?: string;
  credentialId?: string;
  prfSalt?: string;
  transports?: string[];
  lastUsedAt?: string | null;
  usedAt?: string | null;
}

export interface StateView {
  phase: Phase;
  version: string;
  methods: MethodView[];
  settings: Settings;
  lockReason: LockReason | null;
  passwordLockedUntil: number | null;
  lastCheckAt: number | null;
  now: number;
  peopleCount: number | null;
  setupRecoveryMade: boolean;
}

/** A secret as a page sends it. The `prf` output is base64. */
export type SecretMessage =
  | { type: 'password'; password: string }
  | { type: 'recovery'; code: string }
  | { type: 'passkey'; credentialId: string; prfOutput: string };

export interface PasskeyMessage {
  kind: PasskeyKind;
  name: string;
  credentialId: string;
  prfSalt: string;
  prfOutput: string;
  transports: string[];
}

/**
 * The longest operation wording a page may give `zt:encryptForSend` (#3919).
 * The Translator is a generic encryption step: the page that asks names its
 * own operation, such as "Send SMS messages", and the Allow window shows it.
 */
export const MAX_SEND_OPERATION_LENGTH = 80;

export type Request =
  | { type: 'getState' }
  | { type: 'setupAddPassword'; password: string }
  | { type: 'setupAddPasskey'; passkey: PasskeyMessage }
  | { type: 'setupMakeRecovery' }
  | { type: 'setupFinish'; saved: boolean }
  | { type: 'unlock'; secret: SecretMessage }
  | { type: 'check'; secret: SecretMessage }
  | { type: 'lock' }
  | { type: 'getPeople' }
  | { type: 'addPerson'; username: string; email: string }
  | { type: 'renameUser'; from: string; to: string }
  | { type: 'deletePerson'; username: string }
  | { type: 'deleteAll' }
  | { type: 'previewImport'; text: string }
  | { type: 'applyImport'; text: string; fields: DetailField[] }
  | { type: 'importBackup'; text: string; secret: SecretMessage }
  | { type: 'exportBackup' }
  | { type: 'addPasskey'; passkey: PasskeyMessage }
  | { type: 'setPassword'; password: string }
  | { type: 'removeMethod'; id: string }
  | { type: 'newRecoveryCode' }
  | { type: 'setSettings'; autoLockMinutes?: number; lockWhenPcLocks?: boolean }
  | { type: 'lookupNames'; ids: string[] }
  | { type: 'zt:listCodes' }
  | { type: 'zt:encryptForSend'; operation: string; codes: string[]; peopleCount: number; origin: string }
  | { type: 'zt:getAllowRequest'; requestId: string }
  | { type: 'zt:resolveAllow'; requestId: string; decision: 'allow' | 'deny' };

export type ErrorCode =
  | 'forbidden'
  | 'setup-needed'
  | 'not-in-setup'
  | 'locked'
  | 'check-needed'
  | 'wrong-secret'
  | 'password-locked-out'
  | 'invalid'
  | 'last-method'
  | 'not-found'
  | 'bad-file';

export type Failure = { ok: false; error: ErrorCode; message: string };

export type Response<T = object> = ({ ok: true } & T) | Failure;

export interface PeopleResponse {
  people: PersonRecord[];
}

export interface PreviewResponse {
  preview: CsvPreview;
}

export interface ResultResponse {
  result: ImportResult;
}

export interface ExportResponse {
  fileName: string;
  text: string;
}

export interface CodeResponse {
  code: string;
}

export interface NamesResponse {
  phase: Phase;
  names: Record<string, string>;
}

/** One row of board 1's codes table: no PII beyond whether the mobile is valid. */
export interface CodeView {
  code: string;
  username: string;
  hasValidMobile: boolean;
}

/**
 * The page-facing answer to `zt:listCodes`. A locked (or not yet set up)
 * list refuses rather than answering with no codes, so the page cannot
 * mistake "nothing to show yet" for "this list is empty".
 */
export type ListCodesResult = { codes: CodeView[] } | { refused: 'locked' };

/** One row of the batch the walled Lambda (#3920) decrypts. */
export interface SendRow {
  code: string;
  phone: string;
  firstName: string;
}

/** What `encryptBatch` (`send-crypto.ts`) encrypts: the rows, a fresh one-time token and the time, so the walled Lambda can refuse a replayed batch. */
export interface SendBatchPlaintext {
  token: string;
  timestamp: string;
  rows: SendRow[];
}

/** The encrypted batch `zt:encryptForSend` answers with, after Allow. Nothing in clear. */
export interface SendBatch {
  wrappedKey: string;
  iv: string;
  ciphertext: string;
}

/**
 * The page-facing answer to `zt:encryptForSend`. Denied, closed with no
 * decision, a locked list and an origin with no pinned key all refuse
 * before anything is encrypted. `changed` means the list changed (an
 * edit, an import, a delete) while the Allow window was open, so the
 * count the admin saw no longer matches what would be sent — refused
 * rather than sent short of, or different from, what was shown.
 */
export type EncryptForSendResult = { batch: SendBatch } | { refused: 'denied' | 'locked' | 'unknown-origin' | 'busy' | 'changed' };

/** What the Allow window (board 6/11) shows, read by `zt:getAllowRequest`. */
export interface AllowRequestView {
  operation: string;
  peopleCount: number;
  origin: string;
}

export interface AllowRequestResponse {
  request: AllowRequestView;
}

/** The message the service worker sends to every tab after a lock, an unlock or a list change. */
export const REFRESH_MESSAGE = 'zt-refresh';

/** The port an extension page holds open while a Windows Hello or security key dialog runs. */
export const CEREMONY_PORT = 'zt-ceremony';

/** The port `allow.html` holds open for as long as its Allow/Deny decision is pending, so the service worker is not evicted mid-wait. */
export const ALLOW_PORT = 'zt-allow';

/** What a Windows Hello or security key dialog was for: unlock, a check, a setup method or a new method. */
export type CeremonyOp = 'unlock' | 'check' | 'setup' | 'add';

/** The message a page sends on the ceremony port: the dialog starts, or it ended. */
export type CeremonyMessage = { op: CeremonyOp; kind: PasskeyKind } | { done: true };

/** Sends one request to the service worker. */
export function send<T = object>(request: Request): Promise<Response<T>> {
  return chrome.runtime.sendMessage(request) as Promise<Response<T>>;
}
