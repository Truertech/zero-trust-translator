/**
 * The service worker (#3797). It is the only part of the extension that
 * holds the data key, and it holds it in `chrome.storage.session` only:
 * memory that Chrome clears when it closes, readable by extension pages and
 * this worker (`TRUSTED_CONTEXTS`), never by a content script. A content
 * script asks for names by runtime message and gets the names of the
 * markers it found, and nothing else.
 *
 * A Manifest V3 service worker stops when it is idle and starts again on
 * the next event, so no state lives in a variable here: every request reads
 * storage again.
 */
import { ensureCoded } from './code';
import { applyCsv, mergePeople, previewCsv, type ImportResult } from './import';
import {
  AUTO_LOCK_CHOICES,
  CEREMONY_PORT,
  CHECK_WINDOW_MS,
  PASSWORD_LOCKOUT_MS,
  REFRESH_MESSAGE,
  type AllowRequestView,
  type AutoLockMinutes,
  type CeremonyOp,
  type EncryptForSendResult,
  type ErrorCode,
  type Failure,
  type ListCodesResult,
  type LockReason,
  type MethodView,
  type PasskeyMessage,
  type Request,
  type SecretMessage,
  type SendOperation,
  type SendRow,
  type Settings,
  type StateView,
} from './messages';
import { passwordAccepted } from './password';
import { normaliseUkMobile } from './phone-number';
import { encryptBatch } from './send-crypto';
import { LEGACY_STORAGE_KEY, ListError, addPerson, peopleFromLegacy, removePerson, renameUser, sortPeople } from './store';
import { MissingIdColumnError, usernameKey, type DetailField, type PersonRecord } from './types';
import { walledKeyFor, type WalledKey } from './walled-keys';
import {
  BackupFormatError,
  WrongSecretError,
  fromBase64,
  makeBackup,
  makePasskeyMethod,
  makePasswordMethod,
  makeRawDataKey,
  makeRecoveryCode,
  makeRecoveryMethod,
  openBackup,
  openList,
  openWithSecret,
  parseBackup,
  sealList,
  toBase64,
  type Bytes,
  type PasskeyKind,
  type Secret,
  type UnlockMethod,
  type Vault,
} from './vault';

export const VAULT_KEY = 'zt-vault-v1';
export const SETTINGS_KEY = 'zt-settings-v1';
export const LOCKOUT_KEY = 'zt-lockout-v1';
export const UNLOCKED_KEY = 'zt-unlocked-v1';
export const SETUP_KEY = 'zt-setup-v1';
export const LOCK_REASON_KEY = 'zt-lock-reason-v1';
/** When the PC locked, if "Lock when this PC locks" is off. Cleared by a lock. */
export const PC_LOCKED_AT_KEY = 'zt-pc-locked-at-v1';

export { CHECK_WINDOW_MS, PASSWORD_LOCKOUT_MS };
export const MAX_PASSWORD_FAILURES = 5;

const CEREMONY_OPS: readonly CeremonyOp[] = ['unlock', 'check', 'setup', 'add'];

export const DEFAULT_SETTINGS: Settings = { autoLockMinutes: 15, lockWhenPcLocks: true, lastBackupAt: null };

const MESSAGES: Record<ErrorCode, string> = {
  forbidden: 'This request is not allowed.',
  'setup-needed': 'Finish setting up the list first.',
  'not-in-setup': 'The list is already set up.',
  locked: 'Unlock the list first.',
  'check-needed': 'Confirm it is you first.',
  'wrong-secret': 'That password is not right',
  'password-locked-out': 'Too many wrong passwords. Try again in 5 minutes.',
  invalid: 'That is not valid.',
  'last-method': 'The last way to unlock the list cannot be removed.',
  'not-found': 'That was not found.',
  'bad-file': 'This file is not a Zero Trust Translator backup.',
};

const WRONG_SECRET_MESSAGES: Record<SecretMessage['type'], string> = {
  password: 'That password is not right',
  recovery: 'That recovery code is not right',
  passkey: 'That key does not open this list',
};

interface StorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  clear(): Promise<void>;
}

interface Port {
  name: string;
  onMessage: { addListener(fn: (message: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

export interface MessageSender {
  id?: string;
  url?: string;
  tab?: { id?: number };
}

/** The part of the `chrome` API this worker uses, so the unit tests can give a fake. */
export interface ChromeApi {
  runtime: {
    id: string;
    getURL(path: string): string;
    getManifest(): { version: string };
    onMessage: { addListener(fn: (message: unknown, sender: MessageSender, sendResponse: (r: unknown) => void) => boolean | void): void };
    onConnect: { addListener(fn: (port: Port) => void): void };
  };
  storage: {
    local: StorageArea;
    session: StorageArea & { setAccessLevel(options: { accessLevel: string }): Promise<void> };
  };
  idle: {
    setDetectionInterval(seconds: number): void;
    onStateChanged: { addListener(fn: (state: string) => void): void };
  };
  tabs: {
    query(query: object): Promise<{ id?: number }[]>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
    create(properties: { url: string }): Promise<unknown>;
  };
  windows: {
    create(createData: { url: string; type: 'popup'; width: number; height: number }): Promise<{ id?: number }>;
    remove(windowId: number): Promise<void>;
    onRemoved: { addListener(fn: (windowId: number) => void): void };
  };
}

interface Unlocked {
  dataKey: string;
  lastCheckAt: number;
}

interface PendingSetup {
  dataKey: string;
  methods: UnlockMethod[];
}

interface Lockout {
  failures: number;
  lockedUntil: number | null;
}

class RequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string = MESSAGES[code],
  ) {
    super(message);
  }
}

function view(method: UnlockMethod): MethodView {
  if (method.type === 'passkey') {
    const { id, type, createdAt, kind, name, credentialId, prfSalt, transports, lastUsedAt } = method;
    return { id, type, createdAt, kind, name, credentialId, prfSalt, transports, lastUsedAt };
  }
  if (method.type === 'recovery') {
    return { id: method.id, type: method.type, createdAt: method.createdAt, usedAt: method.usedAt };
  }
  return { id: method.id, type: method.type, createdAt: method.createdAt };
}

function toSecret(secret: SecretMessage): Secret {
  if (secret.type === 'passkey') {
    return { type: 'passkey', credentialId: secret.credentialId, prfOutput: fromBase64(secret.prfOutput) };
  }
  return secret;
}

function unlockingMethods(methods: UnlockMethod[]): UnlockMethod[] {
  return methods.filter((m) => m.type !== 'recovery');
}

export interface Background {
  handle(request: Request, sender: MessageSender): Promise<unknown>;
  onIdleState(state: string): Promise<void>;
  onCeremonyPort(port: Port): void;
  onWindowRemoved(windowId: number): void;
  start(): Promise<void>;
}

export function createBackground(api: ChromeApi, now: () => number = () => Date.now()): Background {
  const local = api.storage.local;
  const session = api.storage.session;

  // One request at a time changes storage, so two quick clicks never read
  // the same vault and lose the first write.
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  }

  async function read<T>(area: StorageArea, key: string): Promise<T | undefined> {
    return (await area.get(key))[key] as T | undefined;
  }

  async function settings(): Promise<Settings> {
    return { ...DEFAULT_SETTINGS, ...(await read<Partial<Settings>>(local, SETTINGS_KEY)) };
  }

  async function lockout(): Promise<Lockout> {
    return (await read<Lockout>(local, LOCKOUT_KEY)) ?? { failures: 0, lockedUntil: null };
  }

  async function vault(): Promise<Vault | undefined> {
    return read<Vault>(local, VAULT_KEY);
  }

  async function requireVault(): Promise<Vault> {
    const current = await vault();
    if (!current) {
      throw new RequestError('setup-needed');
    }
    return current;
  }

  async function unlocked(): Promise<Unlocked | undefined> {
    return read<Unlocked>(session, UNLOCKED_KEY);
  }

  async function requireUnlocked(): Promise<{ vault: Vault; state: Unlocked; rawDataKey: Bytes }> {
    const current = await requireVault();
    const state = await unlocked();
    if (!state) {
      throw new RequestError('locked');
    }
    return { vault: current, state, rawDataKey: fromBase64(state.dataKey) };
  }

  /** The guard on Export, Delete my list and every change to the unlock methods. */
  async function requireRecentCheck(): Promise<{ vault: Vault; state: Unlocked; rawDataKey: Bytes }> {
    const current = await requireUnlocked();
    if (now() - current.state.lastCheckAt > CHECK_WINDOW_MS) {
      throw new RequestError('check-needed');
    }
    return current;
  }

  /**
   * Reads the list, giving a code (#3919) to any person who has none yet —
   * every person made before this feature existed. `ensureCoded` is the one
   * path a fresh person and a legacy person both go through: the first read
   * after an upgrade persists the codes it minted, so a later read of the
   * same list never mints a second code for the same person.
   */
  async function people(rawDataKey: Bytes, current: Vault): Promise<PersonRecord[]> {
    const list = await openList(rawDataKey, current.data);
    const coded = ensureCoded(list);
    if (coded.some((p, i) => p.code !== list[i]?.code)) {
      await writeVault({ ...current, data: await sealList(rawDataKey, coded) });
    }
    return coded;
  }

  async function writeVault(next: Vault): Promise<void> {
    await local.set({ [VAULT_KEY]: next });
  }

  async function writePeople(rawDataKey: Bytes, current: Vault, list: PersonRecord[]): Promise<void> {
    await writeVault({ ...current, data: await sealList(rawDataKey, list) });
    await broadcast();
  }

  async function broadcast(): Promise<void> {
    const tabs = await api.tabs.query({});
    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id === undefined) {
          return;
        }
        try {
          await api.tabs.sendMessage(tab.id, { type: REFRESH_MESSAGE });
        } catch {
          // No content script in that tab (any page but the branch platform).
        }
      }),
    );
  }

  async function lock(reason: LockReason): Promise<void> {
    await session.clear();
    await session.set({ [LOCK_REASON_KEY]: reason });
    await broadcast();
  }

  async function applyIdleInterval(): Promise<void> {
    api.idle.setDetectionInterval((await settings()).autoLockMinutes * 60);
  }

  /** Counts a wrong password, and starts the 5-minute lockout on the fifth in a row. */
  async function passwordFailed(): Promise<never> {
    const current = await lockout();
    const failures = current.failures + 1;
    if (failures >= MAX_PASSWORD_FAILURES) {
      await local.set({ [LOCKOUT_KEY]: { failures: 0, lockedUntil: now() + PASSWORD_LOCKOUT_MS } });
      throw new RequestError('password-locked-out');
    }
    await local.set({ [LOCKOUT_KEY]: { failures, lockedUntil: null } });
    throw new RequestError('wrong-secret');
  }

  /** Opens the vault with a secret, with the wrong-password count and the lockout. */
  async function openVault(current: Vault, secret: SecretMessage): Promise<{ rawDataKey: Bytes; method: UnlockMethod }> {
    if (secret.type === 'password') {
      const { lockedUntil } = await lockout();
      if (lockedUntil !== null && now() < lockedUntil) {
        throw new RequestError('password-locked-out');
      }
    }
    try {
      const opened = await openWithSecret(current.methods, toSecret(secret));
      if (secret.type === 'password') {
        await local.set({ [LOCKOUT_KEY]: { failures: 0, lockedUntil: null } });
      }
      return opened;
    } catch (error) {
      if (!(error instanceof WrongSecretError)) {
        throw error;
      }
      if (secret.type === 'password') {
        return passwordFailed();
      }
      throw new RequestError('wrong-secret', WRONG_SECRET_MESSAGES[secret.type]);
    }
  }

  /** Writes when a passkey or the recovery code was last used, for board 18. */
  async function markUsed(current: Vault, method: UnlockMethod): Promise<void> {
    if (method.type === 'password') {
      return;
    }
    const stamp = new Date(now()).toISOString();
    const methods = current.methods.map((m) => {
      if (m.id !== method.id) {
        return m;
      }
      return m.type === 'passkey' ? { ...m, lastUsedAt: stamp } : { ...m, usedAt: stamp };
    });
    await writeVault({ ...current, methods });
  }

  function validPasskey(passkey: PasskeyMessage | undefined): passkey is PasskeyMessage {
    return (
      !!passkey &&
      (passkey.kind === 'platform' || passkey.kind === 'cross-platform') &&
      typeof passkey.credentialId === 'string' &&
      passkey.credentialId.length > 0 &&
      typeof passkey.prfSalt === 'string' &&
      typeof passkey.prfOutput === 'string' &&
      fromBase64(passkey.prfOutput).length >= 32
    );
  }

  function passkeyName(passkey: PasskeyMessage): string {
    const name = typeof passkey.name === 'string' ? passkey.name.trim() : '';
    if (name.length > 0) {
      return name.slice(0, 60);
    }
    return passkey.kind === 'platform' ? 'Windows Hello' : 'Security key';
  }

  async function newPasskeyMethod(rawDataKey: Bytes, passkey: PasskeyMessage | undefined): Promise<UnlockMethod> {
    if (!validPasskey(passkey)) {
      throw new RequestError('invalid');
    }
    return makePasskeyMethod(
      rawDataKey,
      {
        kind: passkey.kind,
        name: passkeyName(passkey),
        credentialId: passkey.credentialId,
        prfSalt: passkey.prfSalt,
        prfOutput: fromBase64(passkey.prfOutput),
        transports: Array.isArray(passkey.transports) ? passkey.transports.filter((t) => typeof t === 'string') : [],
      },
      new Date(now()),
    );
  }

  function requirePassword(password: unknown): string {
    if (typeof password !== 'string' || !passwordAccepted(password)) {
      throw new RequestError('invalid', 'Use at least 12 characters, and not a common password.');
    }
    return password;
  }

  async function pendingSetup(): Promise<PendingSetup> {
    if (await vault()) {
      throw new RequestError('not-in-setup');
    }
    const pending = await read<PendingSetup>(session, SETUP_KEY);
    if (pending) {
      return pending;
    }
    const fresh: PendingSetup = { dataKey: toBase64(await makeRawDataKey()), methods: [] };
    await session.set({ [SETUP_KEY]: fresh });
    return fresh;
  }

  /** Keeps one method of a type in setup: a new password replaces the old one. */
  async function addToSetup(pending: PendingSetup, method: UnlockMethod): Promise<void> {
    const methods = method.type === 'passkey' ? [...pending.methods, method] : [...pending.methods.filter((m) => m.type !== method.type), method];
    await session.set({ [SETUP_KEY]: { ...pending, methods } });
  }

  async function state(): Promise<StateView> {
    const current = await vault();
    const currentSettings = await settings();
    const { lockedUntil } = await lockout();
    const base = {
      version: api.runtime.getManifest().version,
      settings: currentSettings,
      passwordLockedUntil: lockedUntil !== null && now() < lockedUntil ? lockedUntil : null,
      now: now(),
    };
    if (!current) {
      const pending = await read<PendingSetup>(session, SETUP_KEY);
      const methods = pending?.methods ?? [];
      return {
        ...base,
        phase: 'setup',
        methods: methods.map(view),
        lockReason: null,
        lastCheckAt: null,
        peopleCount: null,
        setupRecoveryMade: methods.some((m) => m.type === 'recovery'),
      };
    }
    const open = await unlocked();
    return {
      ...base,
      phase: open ? 'unlocked' : 'locked',
      methods: current.methods.map(view),
      lockReason: open ? null : ((await read<LockReason>(session, LOCK_REASON_KEY)) ?? null),
      lastCheckAt: open ? open.lastCheckAt : null,
      peopleCount: open ? (await people(fromBase64(open.dataKey), current)).length : null,
      setupRecoveryMade: true,
    };
  }

  async function importResultFor(list: PersonRecord[], incoming: PersonRecord[]): Promise<{ people: PersonRecord[]; result: ImportResult }> {
    const merged = mergePeople(list, incoming);
    return {
      people: merged.people,
      result: { kind: 'backup', added: merged.added, updated: merged.updated, unchanged: merged.unchanged, skipped: [] },
    };
  }

  async function run(request: Request): Promise<object> {
    switch (request.type) {
      case 'getState':
        return { state: await state() };

      case 'setupAddPassword': {
        const password = requirePassword(request.password);
        const pending = await pendingSetup();
        await addToSetup(pending, await makePasswordMethod(fromBase64(pending.dataKey), password, new Date(now())));
        return {};
      }

      case 'setupAddPasskey': {
        const pending = await pendingSetup();
        await addToSetup(pending, await newPasskeyMethod(fromBase64(pending.dataKey), request.passkey));
        return {};
      }

      case 'setupMakeRecovery': {
        const pending = await pendingSetup();
        if (unlockingMethods(pending.methods).length === 0) {
          throw new RequestError('invalid', 'Choose how you unlock the list first.');
        }
        const code = makeRecoveryCode();
        await addToSetup(pending, await makeRecoveryMethod(fromBase64(pending.dataKey), code, new Date(now())));
        return { code };
      }

      case 'setupFinish': {
        const pending = await pendingSetup();
        if (unlockingMethods(pending.methods).length === 0 || !pending.methods.some((m) => m.type === 'recovery') || request.saved !== true) {
          throw new RequestError('invalid', 'Choose how you unlock the list, and save the recovery code.');
        }
        const rawDataKey = fromBase64(pending.dataKey);
        // A v0.1.0 list is kept: it goes into the vault, then the plain key goes.
        const legacy = peopleFromLegacy(await read<unknown>(local, LEGACY_STORAGE_KEY));
        await writeVault({
          version: 1,
          createdAt: new Date(now()).toISOString(),
          data: await sealList(rawDataKey, legacy),
          methods: pending.methods,
        });
        await local.remove(LEGACY_STORAGE_KEY);
        await session.clear();
        await session.set({ [UNLOCKED_KEY]: { dataKey: pending.dataKey, lastCheckAt: now() } satisfies Unlocked });
        await applyIdleInterval();
        await broadcast();
        return {};
      }

      case 'unlock': {
        const current = await requireVault();
        const { rawDataKey, method } = await openVault(current, request.secret);
        await markUsed(current, method);
        await session.clear();
        await session.set({ [UNLOCKED_KEY]: { dataKey: toBase64(rawDataKey), lastCheckAt: now() } satisfies Unlocked });
        await broadcast();
        return {};
      }

      case 'check': {
        const { vault: current, state: open } = await requireUnlocked();
        const { method } = await openVault(current, request.secret);
        await markUsed(current, method);
        await session.set({ [UNLOCKED_KEY]: { ...open, lastCheckAt: now() } });
        return {};
      }

      case 'lock':
        // A lock in setup would clear the setup in progress.
        await requireVault();
        await lock('manual');
        return {};

      case 'getPeople': {
        const { vault: current, rawDataKey } = await requireUnlocked();
        return { people: sortPeople(await people(rawDataKey, current)) };
      }

      case 'addPerson': {
        const { vault: current, rawDataKey } = await requireUnlocked();
        await writePeople(rawDataKey, current, addPerson(await people(rawDataKey, current), String(request.username ?? ''), String(request.email ?? '')));
        return {};
      }

      case 'renameUser': {
        const { vault: current, rawDataKey } = await requireUnlocked();
        const list = await people(rawDataKey, current);
        if (!list.some((p) => usernameKey(p.username) === usernameKey(String(request.from ?? '')))) {
          throw new RequestError('not-found');
        }
        await writePeople(rawDataKey, current, renameUser(list, String(request.from), String(request.to ?? '')));
        return {};
      }

      case 'deletePerson': {
        const { vault: current, rawDataKey } = await requireUnlocked();
        await writePeople(rawDataKey, current, removePerson(await people(rawDataKey, current), String(request.username ?? '')));
        return {};
      }

      case 'deleteAll': {
        const { vault: current, rawDataKey } = await requireRecentCheck();
        await writePeople(rawDataKey, current, []);
        return {};
      }

      case 'previewImport': {
        const { vault: current, rawDataKey } = await requireUnlocked();
        return { preview: previewCsv(String(request.text ?? ''), await people(rawDataKey, current)) };
      }

      case 'applyImport': {
        const { vault: current, rawDataKey } = await requireUnlocked();
        const fields = (Array.isArray(request.fields) ? request.fields : []) as DetailField[];
        const { people: next, result } = applyCsv(String(request.text ?? ''), await people(rawDataKey, current), fields);
        await writePeople(rawDataKey, current, next);
        return { result };
      }

      case 'importBackup': {
        const { vault: current, rawDataKey } = await requireUnlocked();
        const backup = parseBackup(String(request.text ?? ''));
        let incoming: PersonRecord[];
        try {
          incoming = await openBackup(backup, toSecret(request.secret));
        } catch (error) {
          if (error instanceof WrongSecretError) {
            throw new RequestError('wrong-secret', WRONG_SECRET_MESSAGES[request.secret.type]);
          }
          throw error;
        }
        const { people: next, result } = await importResultFor(await people(rawDataKey, current), incoming);
        await writePeople(rawDataKey, current, next);
        return { result };
      }

      case 'exportBackup': {
        const { vault: current, rawDataKey } = await requireRecentCheck();
        const stamp = new Date(now());
        const text = await makeBackup(rawDataKey, current.methods, await people(rawDataKey, current), stamp);
        await local.set({ [SETTINGS_KEY]: { ...(await settings()), lastBackupAt: stamp.toISOString() } });
        return { fileName: `zero-trust-translator-${stamp.toISOString().slice(0, 10)}.ztbackup`, text };
      }

      case 'addPasskey': {
        const { vault: current, rawDataKey } = await requireRecentCheck();
        const method = await newPasskeyMethod(rawDataKey, request.passkey);
        await writeVault({ ...current, methods: [...current.methods, method] });
        return {};
      }

      case 'setPassword': {
        const password = requirePassword(request.password);
        const { vault: current, rawDataKey } = await requireRecentCheck();
        const method = await makePasswordMethod(rawDataKey, password, new Date(now()));
        await writeVault({ ...current, methods: [...current.methods.filter((m) => m.type !== 'password'), method] });
        return {};
      }

      case 'removeMethod': {
        const { vault: current } = await requireRecentCheck();
        const method = current.methods.find((m) => m.id === request.id);
        if (!method || method.type === 'recovery') {
          throw new RequestError('not-found');
        }
        if (unlockingMethods(current.methods).length <= 1) {
          throw new RequestError('last-method');
        }
        await writeVault({ ...current, methods: current.methods.filter((m) => m.id !== method.id) });
        return {};
      }

      case 'newRecoveryCode': {
        const { vault: current, rawDataKey } = await requireRecentCheck();
        const code = makeRecoveryCode();
        const method = await makeRecoveryMethod(rawDataKey, code, new Date(now()));
        // The old code stops working: its wrapped key is gone from the vault.
        await writeVault({ ...current, methods: [...current.methods.filter((m) => m.type !== 'recovery'), method] });
        return { code };
      }

      case 'setSettings': {
        const next = { ...(await settings()) };
        if (request.autoLockMinutes !== undefined) {
          if (!AUTO_LOCK_CHOICES.includes(request.autoLockMinutes as AutoLockMinutes)) {
            throw new RequestError('invalid');
          }
          next.autoLockMinutes = request.autoLockMinutes as AutoLockMinutes;
        }
        if (request.lockWhenPcLocks !== undefined) {
          next.lockWhenPcLocks = request.lockWhenPcLocks === true;
        }
        await local.set({ [SETTINGS_KEY]: next });
        await applyIdleInterval();
        return { settings: next };
      }

      default:
        throw new RequestError('invalid');
    }
  }

  async function lookupNames(ids: unknown): Promise<object> {
    const current = await vault();
    if (!current) {
      return { phase: 'setup', names: {} };
    }
    const open = await unlocked();
    if (!open) {
      return { phase: 'locked', names: {} };
    }
    const wanted = new Set((Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === 'string').map(usernameKey));
    const names: Record<string, string> = {};
    for (const person of await people(fromBase64(open.dataKey), current)) {
      const key = usernameKey(person.username);
      if (wanted.has(key) && person.name !== '') {
        names[key] = person.name;
      }
    }
    return { phase: 'unlocked', names };
  }

  /**
   * ADR 0214's lock applies to a page-triggered request the same as to the
   * popup: a locked (or not yet set up) list refuses rather than opening
   * anything sensitive. There is no popup open to show the lock screen in,
   * so this opens the extension's own page in a tab, where it renders that
   * screen the same way.
   */
  async function openUnlockEntry(): Promise<void> {
    await api.tabs.create({ url: api.runtime.getURL('popup.html') });
  }

  /** Board 1's codes table (#3919): the code, the username and whether the phone is a valid UK mobile. No name, no phone, no address. */
  async function listCodes(): Promise<ListCodesResult> {
    const current = await vault();
    const open = current ? await unlocked() : undefined;
    if (!current || !open) {
      await openUnlockEntry();
      return { refused: 'locked' };
    }
    const list = await people(fromBase64(open.dataKey), current);
    return { codes: list.map((p) => ({ code: p.code, username: p.username, hasValidMobile: normaliseUkMobile(p.phone) !== null })) };
  }

  interface PendingAllow {
    view: AllowRequestView;
    codes: string[];
    walledKey: WalledKey;
    windowId: number | undefined;
    resolve: (value: EncryptForSendResult) => void;
    reject: (error: unknown) => void;
  }

  /**
   * One entry per open Allow window (board 6/11). In-memory only: if the
   * service worker is evicted while a window is open, the window's own
   * `zt:getAllowRequest`/`zt:resolveAllow` calls find no entry and fail with
   * `not-found`, which the window shows as an error — the same outcome as
   * the admin closing the window, so the page's own timeout recovers either
   * way. `allow.ts` holds a port open for as long as it waits, which keeps
   * the worker alive for the ordinary case.
   */
  const pendingAllow = new Map<string, PendingAllow>();

  function validSendOperation(value: unknown): value is SendOperation {
    return value === 'sms' || value === 'eventInvite';
  }

  function closeAllowWindow(entry: PendingAllow): void {
    if (entry.windowId !== undefined) {
      void api.windows.remove(entry.windowId).catch(() => undefined);
    }
  }

  /**
   * Opens the Allow window (board 6) and returns a promise that settles
   * when the admin decides, or the window closes with no decision. This
   * runs outside `serialize()`: the wait for the admin is not a storage
   * change, and serializing it would stall every other request — getState,
   * a lock, an import — for as long as the window stays open.
   */
  async function startEncryptForSend(request: Extract<Request, { type: 'zt:encryptForSend' }>): Promise<EncryptForSendResult> {
    const current = await vault();
    const open = current ? await unlocked() : undefined;
    if (!current || !open) {
      await openUnlockEntry();
      return { refused: 'locked' };
    }
    if (!validSendOperation(request.operation)) {
      throw new RequestError('invalid');
    }
    const codes = Array.isArray(request.codes) ? request.codes.filter((c): c is string => typeof c === 'string') : [];
    if (codes.length === 0) {
      throw new RequestError('invalid', 'No codes were given to send to.');
    }
    const origin = String(request.origin ?? '');
    const walledKey = walledKeyFor(origin);
    if (!walledKey) {
      return { refused: 'unknown-origin' };
    }
    // The window shows how many of `codes` the list actually holds, never
    // the page's own claim: a page cannot inflate the count the admin sees.
    const list = await people(fromBase64(open.dataKey), current);
    const byCode = new Map(list.map((p) => [p.code, p]));
    const matchedCount = codes.filter((code) => byCode.has(code)).length;
    const view: AllowRequestView = {
      operation: request.operation,
      template: typeof request.template === 'string' ? request.template : '',
      peopleCount: matchedCount,
      origin,
    };
    const requestId = crypto.randomUUID();
    return new Promise<EncryptForSendResult>((resolve, reject) => {
      pendingAllow.set(requestId, { view, codes, walledKey, windowId: undefined, resolve, reject });
      api.windows
        .create({ url: api.runtime.getURL(`allow.html?requestId=${requestId}`), type: 'popup', width: 420, height: 560 })
        .then((win) => {
          const entry = pendingAllow.get(requestId);
          if (entry) {
            entry.windowId = win.id;
          }
        })
        .catch((error: unknown) => {
          pendingAllow.delete(requestId);
          reject(error);
        });
    });
  }

  async function getAllowRequest(requestId: unknown): Promise<{ request: AllowRequestView }> {
    const entry = pendingAllow.get(String(requestId ?? ''));
    if (!entry) {
      throw new RequestError('not-found');
    }
    return { request: entry.view };
  }

  /** The batch for one Allow decision. Runs inside `serialize()`: the one place that opens the vault to build it, so it never reads a list an import is mid-write on. */
  async function encryptForSendOutcome(entry: PendingAllow, decision: unknown): Promise<EncryptForSendResult> {
    if (decision !== 'allow') {
      return { refused: 'denied' };
    }
    const open = await unlocked();
    if (!open) {
      return { refused: 'locked' };
    }
    const current = await requireVault();
    const byCode = new Map((await people(fromBase64(open.dataKey), current)).map((p) => [p.code, p]));
    const rows: SendRow[] = [];
    for (const code of entry.codes) {
      const person = byCode.get(code);
      const phone = person ? normaliseUkMobile(person.phone) : null;
      if (person && phone) {
        rows.push({ code, phone, firstName: person.firstName });
      }
    }
    return { batch: await encryptBatch(rows, entry.walledKey.publicKeySpki) };
  }

  /**
   * Answers the Allow window itself (board 6/11), and settles the original
   * `zt:encryptForSend` caller's pending promise. `entry.resolve` always
   * runs, even when building the batch throws, so that promise never hangs.
   */
  async function resolveAllow(requestId: unknown, decision: unknown): Promise<object> {
    const id = String(requestId ?? '');
    const entry = pendingAllow.get(id);
    if (!entry) {
      throw new RequestError('not-found');
    }
    pendingAllow.delete(id);
    closeAllowWindow(entry);
    try {
      entry.resolve(await encryptForSendOutcome(entry, decision));
    } catch (error) {
      entry.reject(error);
      throw error;
    }
    return {};
  }

  /** A window closed with no `zt:resolveAllow`: the same outcome as Deny. */
  function onWindowRemoved(windowId: number): void {
    for (const [id, entry] of pendingAllow) {
      if (entry.windowId === windowId) {
        pendingAllow.delete(id);
        entry.resolve({ refused: 'denied' });
      }
    }
  }

  function fromExtensionPage(sender: MessageSender): boolean {
    return typeof sender.url === 'string' && sender.url.startsWith(api.runtime.getURL(''));
  }

  function failure(error: unknown): Failure {
    if (error instanceof RequestError) {
      return { ok: false, error: error.code, message: error.message };
    }
    if (error instanceof ListError) {
      return { ok: false, error: 'invalid', message: error.message };
    }
    if (error instanceof MissingIdColumnError) {
      return { ok: false, error: 'invalid', message: error.message };
    }
    if (error instanceof BackupFormatError) {
      return { ok: false, error: 'bad-file', message: error.message };
    }
    // Any other error (a secret that is not base64, a value of the wrong
    // type) still answers the page, so the page never waits for nothing.
    return { ok: false, error: 'invalid', message: MESSAGES.invalid };
  }

  async function handle(request: Request, sender: MessageSender): Promise<unknown> {
    if (sender.id !== api.runtime.id || !request || typeof request !== 'object') {
      return { ok: false, error: 'forbidden', message: MESSAGES.forbidden } satisfies Failure;
    }
    // A content script may ask for names, the codes table, and to encrypt a send batch.
    if (request.type === 'lookupNames') {
      try {
        return { ok: true, ...(await lookupNames(request.ids)) };
      } catch (error) {
        return failure(error);
      }
    }
    if (request.type === 'zt:listCodes') {
      try {
        return await listCodes();
      } catch (error) {
        return failure(error);
      }
    }
    if (request.type === 'zt:encryptForSend') {
      try {
        return await startEncryptForSend(request);
      } catch (error) {
        return failure(error);
      }
    }
    if (!fromExtensionPage(sender)) {
      return { ok: false, error: 'forbidden', message: MESSAGES.forbidden } satisfies Failure;
    }
    // Only the Allow window (board 6/11) itself sends these.
    if (request.type === 'zt:getAllowRequest') {
      try {
        return { ok: true, ...(await getAllowRequest(request.requestId)) };
      } catch (error) {
        return failure(error);
      }
    }
    if (request.type === 'zt:resolveAllow') {
      try {
        return { ok: true, ...(await serialize(() => resolveAllow(request.requestId, request.decision))) };
      } catch (error) {
        return failure(error);
      }
    }
    try {
      return { ok: true, ...(await serialize(() => run(request))) };
    } catch (error) {
      return failure(error);
    }
  }

  async function onIdleState(idleState: string): Promise<void> {
    if (!(await unlocked())) {
      return;
    }
    const current = await settings();
    if (idleState === 'idle') {
      await lock('idle');
    } else if (idleState === 'locked' && current.lockWhenPcLocks) {
      await lock('pc-locked');
    } else if (idleState === 'locked') {
      // Chrome reports "locked", never "idle", while the PC is locked, so
      // the auto-lock time is counted from here and checked on return.
      await session.set({ [PC_LOCKED_AT_KEY]: now() });
    } else if (idleState === 'active') {
      const lockedAt = await read<number>(session, PC_LOCKED_AT_KEY);
      await session.remove(PC_LOCKED_AT_KEY);
      if (lockedAt !== undefined && now() - lockedAt >= current.autoLockMinutes * 60_000) {
        await lock('idle');
      }
    }
  }

  /**
   * A popup closes when Windows Hello or a security key dialog takes focus,
   * and the WebAuthn request dies with it. The popup holds this port open
   * while the dialog runs; if the port closes before the popup says the
   * request ended, the same request opens in `unlock.html` in a tab, which
   * keeps focus through the dialog.
   */
  function onCeremonyPort(port: Port): void {
    if (port.name !== CEREMONY_PORT) {
      return;
    }
    let pending: { op: CeremonyOp; kind: PasskeyKind } | null = null;
    port.onMessage.addListener((message) => {
      const value = (message ?? {}) as Partial<{ op: CeremonyOp; kind: PasskeyKind; done: boolean }>;
      if (value.done === true) {
        pending = null;
      } else if (value.op && CEREMONY_OPS.includes(value.op) && (value.kind === 'platform' || value.kind === 'cross-platform')) {
        pending = { op: value.op, kind: value.kind };
      }
    });
    port.onDisconnect.addListener(() => {
      if (pending) {
        void api.tabs.create({ url: api.runtime.getURL(`unlock.html?op=${pending.op}&kind=${pending.kind}`) });
      }
    });
  }

  async function start(): Promise<void> {
    await session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await applyIdleInterval();
  }

  return { handle, onIdleState, onCeremonyPort, onWindowRemoved, start };
}

/** Registers the listeners. Chrome needs them added on every start of the worker, at the top level. */
export function installBackground(api: ChromeApi): Background {
  const background = createBackground(api);
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void background.handle(message as Request, sender).then(sendResponse);
    return true;
  });
  api.runtime.onConnect.addListener((port) => background.onCeremonyPort(port));
  api.idle.onStateChanged.addListener((idleState) => void background.onIdleState(idleState));
  api.windows.onRemoved.addListener((windowId) => background.onWindowRemoved(windowId));
  void background.start();
  return background;
}
