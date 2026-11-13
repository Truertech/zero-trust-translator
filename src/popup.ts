/**
 * The toolbar popup. It holds no key and no
 * list of its own: every read and write is a message to the service worker
 * (`background.ts`), which holds the data key while the list is unlocked.
 */
import { isRefCode } from './code';
import { countMatches, isBackupText, type CsvPreview, type ImportResult, type NbPlan } from './import';
import { PASSWORD_LOCKOUT_MS, type SecretMessage, type StateView } from './messages';
import { passwordForm } from './password-form';
import { searchPeople } from './store';
import { DETAIL_FIELDS, type DetailField, type PersonKind, type PersonRecord, usernameKey } from './types';
import {
  RequestFailed,
  autoLockLabel,
  call,
  ceremonyError,
  checkIsRecent,
  formatDate,
  getState,
  h,
  hasPassword,
  minutesAgo,
  pageLink,
  newPasskey,
  passkeySecret,
  passkeys,
  peopleLabel,
  saveFile,
  svg,
  withCeremony,
} from './ui';
import { BackupFormatError, parseBackup, recoveryCodeGroups, type Backup, type PasskeyKind } from './vault';
import { assertPasskey, platformAuthenticatorAvailable } from './webauthn';

const root = document.getElementById('app') as HTMLElement;

let state: StateView;
let people: PersonRecord[] = [];
let query = '';

const KIND_LABELS: Record<PersonKind, string> = { user: 'Volunteer', member: 'Member', respondent: 'Respondent', '': '' };
const FIELD_LABELS: Record<DetailField, string> = { name: 'Name', phone: 'Phone', address: 'Address', postcode: 'Postcode' };
const NO_NAME = 'No name yet';

function show(screen: HTMLElement): void {
  root.replaceChildren(screen);
  screen.querySelector<HTMLElement>('[autofocus]')?.focus();
}

function messageOf(error: unknown): string {
  return error instanceof RequestFailed || error instanceof Error ? error.message : String(error);
}

async function refreshState(): Promise<void> {
  state = await getState();
}

// ---------------------------------------------------------------- headers

function brandHeader(...extra: (Node | false)[]): HTMLElement {
  return h('div', { class: 'hd' }, h('div', { class: 'logo' }, svg('shieldCheck', 16, 2.2)), h('div', { class: 'ttl' }, 'Zero Trust Translator'), ...extra);
}

function bar(title: string, back: () => void, ...extra: (Node | false)[]): HTMLElement {
  return h(
    'div',
    { class: 'bar' },
    h('button', { class: 'back', type: 'button', 'aria-label': 'Back', testid: 'zt-back', onclick: back }, svg('back', 18)),
    h('div', { class: 'ttl' }, title),
    ...extra,
  );
}

function privacyBanner(): HTMLElement {
  return h(
    'div',
    { class: 'banner' },
    svg('lock', 20),
    h('div', { class: 't' }, 'Your list never leaves this computer'),
    h('button', { class: 'link', type: 'button', testid: 'zt-privacy-link', onclick: showPrivacy }, 'How?'),
  );
}

function sourceLink(): HTMLElement {
  return h('a', { href: pageLink('source'), target: '_blank', rel: 'noreferrer' }, 'Source code');
}

function lockReasonText(): string {
  switch (state.lockReason) {
    case 'idle':
      return `Locked after ${autoLockLabel(state.settings.autoLockMinutes)} idle`;
    case 'pc-locked':
      return 'Locked when this PC locked';
    case 'manual':
      return 'Locked';
    default:
      return 'Locked when Chrome closed';
  }
}

// ---------------------------------------------------------------- first start

async function showSetup(): Promise<void> {
  const hello = await platformAuthenticatorAvailable();
  const error = h('p', { class: 'err', testid: 'zt-setup-error', role: 'alert' });
  const way = (testid: string, iconName: 'hello' | 'securityKey' | 'password', title: string, recommended: boolean, text: string, onclick: () => void) =>
    h(
      'button',
      { class: 'way', type: 'button', testid, onclick },
      h('div', { class: 'ic' }, svg(iconName, 22, 1.8)),
      h('div', { style: 'flex:1' }, h('b', {}, title, recommended && h('span', { class: 'rec' }, 'Recommended')), h('span', { class: 'd' }, text)),
    );
  const setupPasskey = async (kind: PasskeyKind): Promise<void> => {
    error.textContent = '';
    try {
      const passkey = await withCeremony('setup', kind, () => newPasskey(kind, kind === 'platform' ? 'Windows Hello' : 'Security key'));
      await call({ type: 'setupAddPasskey', passkey });
      await refreshState();
      await showRecovery();
    } catch (e) {
      error.textContent = e instanceof RequestFailed ? e.message : (ceremonyError(e) ?? '');
    }
  };
  show(
    h(
      'div',
      { class: 'screen tint', testid: 'zt-setup' },
      brandHeader(h('span', { class: 'step' }, 'Step 1 of 2')),
      h(
        'div',
        { class: 'setup' },
        h('div', { class: 'intro' }, h('div', { class: 'h' }, 'Protect your list'), h('div', { class: 'p' }, 'Your list is encrypted. Choose how you unlock it.')),
        hello && way('zt-setup-hello', 'hello', 'Windows Hello', true, 'Face, fingerprint or Windows PIN on this PC', () => void setupPasskey('platform')),
        way('zt-setup-key', 'securityKey', 'Security key', true, 'A USB or NFC key, for example a YubiKey', () => void setupPasskey('cross-platform')),
        way('zt-setup-password', 'password', 'Password', false, 'At least 12 characters', showSetupPassword),
        error,
        h('div', { class: 'later' }, 'You can add more ways later in Security settings'),
        h('div', { class: 'dots', 'aria-hidden': 'true' }, h('i', { class: 'on' }), h('i')),
      ),
    ),
  );
}

function showSetupPassword(): void {
  const error = h('p', { class: 'err', testid: 'zt-setup-error', role: 'alert' });
  const next = h('button', { class: 'btn pri big', type: 'button', testid: 'zt-setup-continue', disabled: true }, 'Continue');
  const form = passwordForm((ok) => (next.disabled = !ok));
  next.addEventListener('click', () => {
    void (async () => {
      next.disabled = true;
      try {
        await call({ type: 'setupAddPassword', password: form.value() });
        await refreshState();
        await showRecovery();
      } catch (e) {
        error.textContent = messageOf(e);
        next.disabled = false;
      }
    })();
  });
  show(
    h(
      'div',
      { class: 'screen', testid: 'zt-setup-create' },
      bar('Create a password', () => void showSetup(), h('span', { class: 'step' }, 'Step 1 of 2')),
      h('div', { class: 'body' }, form.element, error),
      h('div', { class: 'actions', style: 'flex-direction:column;gap:10px' }, next, h('div', { class: 'dots', 'aria-hidden': 'true' }, h('i', { class: 'on' }), h('i'))),
    ),
  );
}

/** The recovery code is shown once. A new visit to this screen makes a new code. */
async function showRecovery(): Promise<void> {
  const { code } = await call<{ code: string }>({ type: 'setupMakeRecovery' });
  const groups = recoveryCodeGroups(code);
  const finish = h('button', { class: 'btn pri', type: 'button', testid: 'zt-finish', disabled: true }, 'Finish');
  const saved = h('input', { type: 'checkbox', testid: 'zt-recovery-saved' });
  const error = h('p', { class: 'err', role: 'alert' });
  const copied = h('span', { class: 'step', role: 'status', testid: 'zt-recovery-copied' });
  saved.addEventListener('change', () => (finish.disabled = !saved.checked));
  finish.addEventListener('click', () => {
    void (async () => {
      finish.disabled = true;
      try {
        await call({ type: 'setupFinish', saved: saved.checked });
        await enterUnlocked();
      } catch (e) {
        error.textContent = messageOf(e);
        finish.disabled = false;
      }
    })();
  });
  show(
    h(
      'div',
      { class: 'screen', testid: 'zt-recovery' },
      bar('Your recovery code', () => void showSetup(), h('span', { class: 'step' }, 'Step 2 of 2')),
      h(
        'div',
        { class: 'body' },
        h('div', { style: 'font-size:13px;color:#30353C' }, 'Unlocks the list and your backups if you forget your password or lose your key. Shown once.'),
        h('div', { class: 'codes mono', testid: 'zt-recovery-code' }, ...groups.map((g) => h('div', { class: 'g' }, g))),
        h(
          'div',
          { style: 'display:flex;gap:8px' },
          h(
            'button',
            {
              class: 'btn',
              type: 'button',
              style: 'flex:1',
              testid: 'zt-recovery-copy',
              onclick: () => {
                void navigator.clipboard.writeText(groups.join(' ')).then(
                  () => (copied.textContent = 'Copied'),
                  () => (copied.textContent = 'Copy did not work. Write the code down.'),
                );
              },
            },
            svg('copy'),
            'Copy',
          ),
          h('button', { class: 'btn', type: 'button', style: 'flex:1', testid: 'zt-recovery-print', onclick: () => window.print() }, svg('print'), 'Print'),
        ),
        copied,
        h(
          'div',
          { class: 'note warn' },
          svg('warning', 18, 2, '#8A4B00'),
          h('span', {}, "Keep it in your organisation's secure storage, such as OneDrive or Outlook. Without it, a forgotten password or lost key means the list is gone."),
        ),
        h('label', { class: 'saved' }, saved, 'I have saved the recovery code'),
        error,
      ),
      h('div', { class: 'actions' }, finish),
    ),
  );
}

// ---------------------------------------------------------------- locked

function unlockButtons(op: 'unlock' | 'check', labels: { hello: string; key: string; password: string }, testids: { hello: string; key: string; password: string }, onPassword: () => void, onDone: () => Promise<void>, error: HTMLElement): HTMLElement[] {
  const buttons: HTMLElement[] = [];
  const withKey = (kind: PasskeyKind) => async (): Promise<void> => {
    error.textContent = '';
    try {
      const secret = await withCeremony(op, kind, () => passkeySecret(state, kind));
      await call({ type: op, secret });
      await onDone();
    } catch (e) {
      error.textContent = e instanceof RequestFailed ? e.message : (ceremonyError(e) ?? '');
    }
  };
  if (passkeys(state, 'platform').length > 0) {
    buttons.push(h('button', { class: 'btn big', type: 'button', testid: testids.hello, onclick: () => void withKey('platform')() }, svg('hello', 20, 1.8), labels.hello));
  }
  if (passkeys(state, 'cross-platform').length > 0) {
    buttons.push(h('button', { class: 'btn big', type: 'button', testid: testids.key, onclick: () => void withKey('cross-platform')() }, svg('securityKey', 20, 1.8), labels.key));
  }
  if (hasPassword(state)) {
    buttons.push(h('button', { class: 'btn big', type: 'button', testid: testids.password, onclick: onPassword }, svg('password', 20, 1.8), labels.password));
  }
  buttons[0]?.classList.add('pri');
  return buttons;
}

function showLock(): void {
  const error = h('p', { class: 'err', testid: 'zt-unlock-error', role: 'alert' });
  const buttons = unlockButtons(
    'unlock',
    { hello: 'Unlock with Windows Hello', key: 'Use security key', password: 'Use password' },
    { hello: 'zt-unlock-hello', key: 'zt-unlock-key', password: 'zt-unlock-password' },
    showUnlockPassword,
    enterUnlocked,
    error,
  );
  show(
    h(
      'div',
      { class: 'screen tint', testid: 'zt-locked' },
      brandHeader(),
      h(
        'div',
        { class: 'centre', style: 'padding:36px 28px 20px' },
        h('div', { class: 'disc lg' }, svg('lockKeyhole', 34, 1.8)),
        h('div', { class: 'h' }, 'Your list is locked'),
        h('div', { class: 'p' }, 'Names show as usernames until you unlock'),
        h('div', { class: 'go top' }, ...buttons),
        error,
      ),
      h('div', { class: 'ft lk' }, h('button', { class: 'link', type: 'button', testid: 'zt-unlock-recovery', onclick: showUnlockRecovery }, 'Use recovery code'), h('span', {}, lockReasonText())),
    ),
  );
}

interface SecretScreen {
  title: string;
  kind: 'password' | 'recovery';
  submit: string;
  back: () => void;
  run: (secret: SecretMessage) => Promise<void>;
  alt?: { label: string; run: () => void } | undefined;
  footer?: HTMLElement | undefined;
}

/** The check, for a password or a recovery code: unlock, a check before a guarded action, or a backup import. */
function showSecret(screen: SecretScreen): void {
  const isPassword = screen.kind === 'password';
  const input = h('input', {
    id: 'pw',
    type: isPassword ? 'password' : 'text',
    autocomplete: isPassword ? 'current-password' : 'off',
    spellcheck: 'false',
    class: isPassword ? '' : 'mono',
    placeholder: isPassword ? '' : 'XXXX-XXXX XXXX-XXXX XXXX-XXXX XXXX-XXXX',
    testid: isPassword ? 'zt-password-field' : 'zt-recovery-field',
    autofocus: true,
  });
  const box = h('div', { class: 'pwbox' }, input);
  if (isPassword) {
    const eye = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Show password', testid: 'zt-password-toggle' }, svg('eye', 18));
    eye.addEventListener('click', () => {
      const hidden = input.type === 'password';
      input.type = hidden ? 'text' : 'password';
      eye.setAttribute('aria-label', hidden ? 'Hide password' : 'Show password');
      eye.replaceChildren(svg(hidden ? 'eyeOff' : 'eye', 18));
    });
    box.append(eye);
  }
  const error = h('p', { class: 'err', testid: 'zt-password-error', role: 'alert', style: 'text-align:center;margin:0' });
  const submit = h('button', { class: 'btn big pri', type: 'submit', testid: 'zt-password-submit' }, screen.submit);
  const lockOut = (until: number): void => {
    input.disabled = true;
    submit.disabled = true;
    error.textContent = 'Too many wrong passwords. Try again in 5 minutes.';
    setTimeout(
      () => {
        input.disabled = false;
        submit.disabled = false;
        error.textContent = '';
      },
      Math.max(0, until - Date.now()),
    );
  };
  if (isPassword && state.passwordLockedUntil !== null) {
    lockOut(Date.now() + (state.passwordLockedUntil - state.now));
  }
  const form = h(
    'form',
    { class: 'pwd' },
    h('label', { for: 'pw' }, isPassword ? 'Enter your password' : 'Enter your recovery code'),
    box,
    error,
    h('div', { class: 'go' }, submit, screen.alt && h('button', { class: 'btn big', type: 'button', testid: 'zt-secret-alt', onclick: screen.alt.run }, screen.alt.label)),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void (async () => {
      error.textContent = '';
      submit.disabled = true;
      const secret: SecretMessage = isPassword ? { type: 'password', password: input.value } : { type: 'recovery', code: input.value };
      try {
        await screen.run(secret);
      } catch (e) {
        submit.disabled = false;
        box.classList.add('bad');
        if (e instanceof RequestFailed && e.code === 'password-locked-out') {
          lockOut(Date.now() + PASSWORD_LOCKOUT_MS);
          return;
        }
        error.textContent = messageOf(e);
        input.select();
      }
    })();
  });
  input.addEventListener('input', () => box.classList.remove('bad'));
  show(h('div', { class: 'screen tint', testid: 'zt-secret' }, bar(screen.title, screen.back), form, screen.footer));
}

function lockFooter(left: HTMLElement): HTMLElement {
  return h('div', { class: 'ft lk' }, left, h('span', {}, lockReasonText()));
}

function showUnlockPassword(): void {
  const hello = passkeys(state, 'platform').length > 0;
  const key = passkeys(state, 'cross-platform').length > 0;
  showSecret({
    title: 'Unlock with password',
    kind: 'password',
    submit: 'Unlock',
    back: showLock,
    run: async (secret) => {
      await call({ type: 'unlock', secret });
      await enterUnlocked();
    },
    alt: hello ? { label: 'Use Windows Hello instead', run: showLock } : key ? { label: 'Use security key instead', run: showLock } : undefined,
    footer: lockFooter(h('button', { class: 'link', type: 'button', testid: 'zt-unlock-recovery', onclick: showUnlockRecovery }, 'Forgot password?')),
  });
}

function showUnlockRecovery(): void {
  showSecret({
    title: 'Unlock with recovery code',
    kind: 'recovery',
    submit: 'Unlock',
    back: showLock,
    run: async (secret) => {
      await call({ type: 'unlock', secret });
      await enterUnlocked();
    },
    footer: lockFooter(h('span', {}, 'The code is in 4 groups of 8')),
  });
}

async function enterUnlocked(): Promise<void> {
  await refreshState();
  query = '';
  await showMain();
}

// ---------------------------------------------------------------- the list

async function loadPeople(): Promise<void> {
  people = (await call<{ people: PersonRecord[] }>({ type: 'getPeople' })).people;
}

function initials(person: PersonRecord): string {
  const source = person.name.trim() || person.username.trim();
  const words = source.split(/\s+/).filter(Boolean);
  const letters = words.length >= 2 ? words[0]![0]! + words[words.length - 1]![0]! : source.slice(0, 2);
  return letters.toUpperCase();
}

function personRow(person: PersonRecord): HTMLElement {
  return h(
    'button',
    { class: 'person', type: 'button', testid: 'zt-person', 'data-username': person.username, onclick: () => showEdit(person) },
    h('div', { class: 'av', 'aria-hidden': 'true' }, initials(person)),
    h('div', { class: 'pn' }, h('div', { class: person.name ? 'n' : 'n none' }, person.name || NO_NAME), h('div', { class: 'u mono' }, person.username)),
    person.kind !== '' && h('span', { class: 'kind' }, KIND_LABELS[person.kind]),
  );
}

async function showMain(): Promise<void> {
  await refreshState();
  if (state.phase !== 'unlocked') {
    route();
    return;
  }
  await loadPeople();
  if (people.length === 0) {
    showEmpty();
    return;
  }
  const list = h('div', { class: 'list', testid: 'zt-list' });
  const count = h('span', { testid: 'zt-count' });
  const draw = (): void => {
    const shown = searchPeople(people, query);
    count.textContent = shown.length === people.length ? peopleLabel(people.length) : `${shown.length} of ${peopleLabel(people.length)}`;
    list.replaceChildren(...shown.map(personRow));
    if (shown.length === 0) {
      list.append(h('div', { class: 'nomatch' }, `No one matches “${query.trim()}”`));
    }
  };
  const search = h('input', { 'aria-label': 'Search names or usernames', placeholder: 'Search names or usernames', value: query, testid: 'zt-search', autofocus: true });
  search.addEventListener('input', () => {
    query = search.value;
    draw();
  });
  const lastBackup = state.settings.lastBackupAt ? `Last backup ${formatDate(state.settings.lastBackupAt)}` : 'No backup yet';
  show(
    h(
      'div',
      { class: 'screen tint', testid: 'zt-main' },
      brandHeader(
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Security settings', testid: 'zt-settings', onclick: () => void chrome.runtime.openOptionsPage() }, svg('gear', 18)),
        h('button', { class: 'btn', type: 'button', style: 'height:32px;padding:0 10px', testid: 'zt-lock', onclick: () => void lockNow() }, svg('lock', 14, 2.2), 'Lock'),
      ),
      privacyBanner(),
      h(
        'div',
        { class: 'tools' },
        h('label', { class: 'search' }, svg('search', 16, 2, '#57606A'), search),
        h('button', { class: 'btn', type: 'button', 'aria-label': 'Add person', testid: 'zt-add', onclick: showAdd }, svg('plus')),
      ),
      h(
        'div',
        { class: 'row2' },
        h('button', { class: 'btn', type: 'button', testid: 'zt-import', onclick: () => showImportChoose() }, svg('upload'), 'Import'),
        h('button', { class: 'btn', type: 'button', testid: 'zt-export', onclick: () => void startExport() }, svg('download'), 'Export backup'),
      ),
      h('div', { class: 'counts' }, count, h('span', { testid: 'zt-last-backup' }, lastBackup)),
      list,
      h('div', { class: 'ft' }, h('span', {}, `v${state.version} · Auto-lock in ${autoLockLabel(state.settings.autoLockMinutes)}`), sourceLink()),
    ),
  );
  draw();
}

function showEmpty(): void {
  show(
    h(
      'div',
      { class: 'screen tint', testid: 'zt-empty' },
      brandHeader(h('span', { class: 'chip' }, `v${state.version}`)),
      privacyBanner(),
      h(
        'div',
        { class: 'empty' },
        h('div', { class: 'tile' }, svg('userPlus', 28, 1.8)),
        h('div', { class: 'h' }, 'No people yet'),
        h('div', { class: 'p' }, 'Import people.csv from the Zero Trust download, a NationBuilder Export file or a backup.'),
        h(
          'div',
          { class: 'go' },
          h('button', { class: 'btn pri', type: 'button', testid: 'zt-import', onclick: () => showImportChoose() }, svg('upload'), 'Import CSV file'),
          h('button', { class: 'btn', type: 'button', testid: 'zt-add', onclick: showAdd }, svg('plus'), 'Add one person'),
        ),
      ),
      h('div', { class: 'ft' }, h('span', {}, 'Works offline · No account'), sourceLink()),
    ),
  );
}

async function lockNow(): Promise<void> {
  await call({ type: 'lock' });
  await refreshState();
  showLock();
}

function showPrivacy(): void {
  const point = (iconName: Parameters<typeof svg>[0], title: string, ...text: (Node | string)[]) =>
    h('div', { class: 'pt' }, h('div', { class: 'ic' }, svg(iconName, 18)), h('div', {}, h('b', {}, title), h('span', {}, ...text)));
  show(
    h(
      'div',
      { class: 'screen', testid: 'zt-privacy' },
      bar('How your list is protected', () => void showMain()),
      h(
        'div',
        { class: 'hero' },
        svg('shieldLock', 23, 1.8),
        h('div', {}, h('div', { class: 'h' }, 'No data ever leaves this computer'), h('div', { class: 'p' }, 'Names stay on this PC. Not on our servers, not in your Google account.')),
      ),
      h(
        'div',
        { class: 'pts' },
        point('noNetwork', 'No internet access', 'The extension has no permission to contact any server. Chrome blocks every network request from the extension.'),
        point('browser', 'Runs on one site only', 'Active only on rb-branch.org.uk. It cannot see any other website.'),
        point('monitor', 'Encrypted on this computer', 'Kept in this Chrome profile only, encrypted. Only your Windows Hello, security key, password or recovery code opens it. Never synced to other devices.'),
        point('eyeOff', 'Hidden from the website', "Names are drawn in a sealed layer. The branch platform's code cannot read them, so it can never send them back."),
        point(
          'code',
          'Open source, checkable build',
          `Anyone can rebuild v${state.version} from the source and get the same file. `,
          h('a', { href: pageLink('release'), target: '_blank', rel: 'noreferrer' }, 'Check this release'),
        ),
      ),
      h(
        'div',
        { class: 'warnbar' },
        svg('warning', 18, 2, '#8A4B00'),
        h('div', { class: 't' }, 'Removing the extension deletes the list.'),
        h('button', { class: 'btn', type: 'button', testid: 'zt-export-backup', onclick: () => void startExport() }, 'Export backup'),
      ),
    ),
  );
}

function readOnlyRow(label: string, value: string): HTMLElement {
  return h('div', { class: 'ro' }, h('span', {}, label), h('span', {}, value || '—'));
}

function showEdit(person: PersonRecord): void {
  // A `ref-` username is a placeholder (a wipe reference, or a person added
  // from a NationBuilder file): the field starts empty for the real username.
  const placeholder = isRefCode(usernameKey(person.username));
  const username = h('input', {
    id: 'zid',
    class: 'mono',
    value: placeholder ? '' : person.username,
    placeholder: placeholder ? 'Type the username' : undefined,
    testid: 'zt-person-username',
    autocomplete: 'off',
    spellcheck: 'false',
    autofocus: true,
  });
  const error = h('p', { class: 'err', testid: 'zt-edit-error', role: 'alert', style: 'margin:0' });
  const save = h('button', { class: 'btn pri', type: 'button', testid: 'zt-person-save' }, 'Save');
  save.addEventListener('click', () => {
    void (async () => {
      if (username.value.trim() === person.username) {
        await showMain();
        return;
      }
      save.disabled = true;
      try {
        await call({ type: 'renameUser', from: person.username, to: username.value });
        await showMain();
      } catch (e) {
        error.textContent = messageOf(e);
        username.setAttribute('aria-invalid', 'true');
        save.disabled = false;
      }
    })();
  });
  username.addEventListener('input', () => {
    error.textContent = '';
    username.removeAttribute('aria-invalid');
  });
  const deleteBtn = h('button', { class: 'btn dng', type: 'button', style: 'align-self:flex-start', testid: 'zt-edit-delete' }, svg('trash'), 'Delete person');
  deleteBtn.addEventListener('click', () => {
    void (async () => {
      deleteBtn.disabled = true;
      try {
        await call({ type: 'deletePerson', username: person.username });
        await showMain();
      } catch (e) {
        error.textContent = messageOf(e);
        deleteBtn.disabled = false;
      }
    })();
  });
  show(
    h(
      'div',
      { class: 'screen', testid: 'zt-edit' },
      bar('Edit person', () => void showMain(), person.kind !== '' && h('span', { class: 'kind' }, KIND_LABELS[person.kind])),
      h(
        'div',
        { class: 'body' },
        h('div', { class: 'f' }, h('label', { for: 'zid' }, 'Username or reference'), username, error),
        h(
          'div',
          {},
          readOnlyRow('Name', person.name),
          readOnlyRow('Email', person.email),
          readOnlyRow('Mobile', person.phone),
          readOnlyRow('ID', person.code),
          readOnlyRow('Address', person.address),
          readOnlyRow('Postcode', person.postcode),
        ),
        h(
          'div',
          { class: 'note' },
          svg('info', 18),
          h('span', {}, 'To change other details, update them in NationBuilder, then ', h('button', { class: 'link', type: 'button', testid: 'zt-edit-reimport', onclick: () => showImportChoose() }, 'import the export again'), '.'),
        ),
        deleteBtn,
      ),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', testid: 'zt-edit-cancel', onclick: () => void showMain() }, 'Cancel'), save),
    ),
  );
}

function showAdd(): void {
  const username = h('input', { id: 'nid', class: 'mono', testid: 'zt-add-username', autocomplete: 'off', spellcheck: 'false', autofocus: true });
  const email = h('input', { id: 'nem', type: 'email', testid: 'zt-add-email', autocomplete: 'off' });
  const error = h('p', { class: 'err', testid: 'zt-add-error', role: 'alert', style: 'margin:0' });
  const save = h('button', { class: 'btn pri', type: 'button', testid: 'zt-add-save' }, 'Save');
  save.addEventListener('click', () => {
    void (async () => {
      save.disabled = true;
      try {
        await call({ type: 'addPerson', username: username.value, email: email.value });
        await showMain();
      } catch (e) {
        error.textContent = messageOf(e);
        save.disabled = false;
      }
    })();
  });
  show(
    h(
      'div',
      { class: 'screen', testid: 'zt-add-person' },
      bar('Add person', () => void showMain()),
      h(
        'div',
        { class: 'body' },
        h('div', { class: 'f' }, h('label', { for: 'nid' }, 'Username or reference'), username),
        h('div', { class: 'f' }, h('label', { for: 'nem' }, 'Email'), email),
        error,
        h('div', { class: 'note' }, svg('info', 18), h('span', {}, 'The name and the other details come from the next import of people.csv or a NationBuilder Export.')),
      ),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', testid: 'zt-add-cancel', onclick: () => void showMain() }, 'Cancel'), save),
    ),
  );
}

// ---------------------------------------------------------------- import

function showImportChoose(message = ''): void {
  const error = h('p', { class: 'err', testid: 'zt-import-error', role: 'alert', style: 'margin:0' }, message);
  const input = h('input', { type: 'file', accept: '.csv,.ztbackup,text/csv,application/json', testid: 'zt-import-file', class: 'hidden' });
  const read = async (file: File | undefined): Promise<void> => {
    if (!file) {
      return;
    }
    error.textContent = '';
    const text = await file.text();
    try {
      if (isBackupText(text)) {
        showBackupSecret(file.name, text, parseBackup(text));
        return;
      }
      const { preview } = await call<{ preview: CsvPreview }>({ type: 'previewImport', text });
      if (preview.kind === 'nationbuilder') {
        showNbPreview(file.name, text, preview, [...DETAIL_FIELDS]);
        return;
      }
      const { result } = await call<{ result: ImportResult }>({ type: 'applyImport', text, fields: [...DETAIL_FIELDS] });
      showResult(result);
    } catch (e) {
      error.textContent = e instanceof BackupFormatError ? e.message : messageOf(e);
    }
  };
  input.addEventListener('change', () => void read(input.files?.[0]));
  const drop = h(
    'div',
    { class: 'drop' },
    svg('fileUpload', 30, 1.8),
    h('div', { class: 'h' }, 'Drop a CSV file here'),
    h('label', { class: 'btn pri' }, 'Choose file', input),
    h('div', { class: 'p' }, 'The file is read on this computer only'),
  );
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('over');
    void read(event.dataTransfer?.files[0]);
  });
  const format = (tag: string, title: string, text: string, plain = false) =>
    h('div', { class: 'fmt' }, h('span', { class: plain ? 'tag plain' : 'tag' }, tag), h('div', {}, h('b', {}, title), h('span', {}, text)));
  show(
    h(
      'div',
      { class: 'screen', testid: 'zt-import-choose' },
      bar('Import', () => void showMain()),
      h(
        'div',
        { class: 'body' },
        drop,
        error,
        h(
          'div',
          {},
          h('div', { class: 'sect' }, 'Files you can import'),
          format('ZT', 'people.csv', 'From the Zero Trust download'),
          format('NB', 'NationBuilder Export', 'Matched by email; new emails are added'),
          format('ZT', 'Encrypted backup', 'A .ztbackup file from Export backup'),
          format('CSV', 'Other CSV', 'Columns username or reference, and name', true),
        ),
      ),
    ),
  );
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

function showNbPreview(fileName: string, text: string, preview: Extract<CsvPreview, { kind: 'nationbuilder' }>, fields: DetailField[]): void {
  const plan = preview.plan;
  const notImported = plan.noEmail.length + plan.duplicate.length;
  const summary = h('div', { testid: 'zt-import-summary' });
  const review = h('button', { class: 'btn pri', type: 'button', testid: 'zt-import-review' });
  const line = (label: string, value: number, extra: string, colour?: string) =>
    h('div', { class: `ln ${extra}`, testid: `zt-import-count-${label.toLowerCase().replace(/[^a-z]+/g, '-')}` }, h('span', {}, label), h('span', colour ? { style: `color:${colour}` } : {}, String(value)));
  const draw = (): void => {
    const { changed, upToDate } = countMatches(plan, fields);
    summary.replaceChildren(
      line('Matched to a username by email', plan.matched.length, 'rule', '#0F766E'),
      line('Name or details change', changed, 'sub'),
      line('Already up to date', upToDate, 'sub rule'),
      line('New people, no username yet', plan.newPeople.length, 'rule', '#0F766E'),
      line('Not imported', notImported, 'rule', '#B42318'),
      line('No email', plan.noEmail.length, 'sub'),
      line('Email twice in the file', plan.duplicate.length, 'sub'),
    );
    const total = changed + plan.newPeople.length;
    review.textContent = total === 0 ? 'Nothing to update' : `Review ${plural(total, 'change', 'changes')}`;
    review.disabled = total === 0;
  };
  review.addEventListener('click', () => showNbConfirm(fileName, text, preview, fields));
  const fieldBoxes = DETAIL_FIELDS.map((field) => {
    const box = h('input', { type: 'checkbox', checked: fields.includes(field), testid: `zt-import-field-${field}` });
    box.addEventListener('change', () => {
      fields = DETAIL_FIELDS.filter((f) => (f === field ? box.checked : fields.includes(f)));
      draw();
    });
    return h('label', {}, box, FIELD_LABELS[field]);
  });
  show(
    h(
      'div',
      { class: 'screen', testid: 'zt-import-preview' },
      bar('Import', () => showImportChoose()),
      h(
        'div',
        { class: 'body' },
        h(
          'div',
          { class: 'filebox' },
          svg('file', 22),
          h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 'nm mono' }, fileName), h('div', { class: 'meta' }, `${preview.label} · ${plural(preview.rowCount, 'row', 'rows')}`)),
        ),
        summary,
        plan.newPeople.length > 0 &&
          h(
            'div',
            { class: 'note', testid: 'zt-import-new-note' },
            svg('alert', 18, 2),
            h(
              'span',
              {},
              `${plan.newPeople.length === 1 ? '1 email is' : `${plan.newPeople.length} emails are`} not in your list. ${plan.newPeople.length === 1 ? 'It is' : 'They are'} added with no username. Open each person in the list to type the username.`,
            ),
          ),
        h('div', {}, h('div', { class: 'label' }, 'Fields to update'), h('div', { class: 'fields' }, ...fieldBoxes)),
      ),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', testid: 'zt-import-preview-cancel', onclick: () => void showMain() }, 'Cancel'), review),
    ),
  );
  draw();
}

const SHOWN_CHANGES = 4;

function showNbConfirm(fileName: string, text: string, preview: Extract<CsvPreview, { kind: 'nationbuilder' }>, fields: DetailField[]): void {
  const changed = [...changedMatches(preview.plan, fields), ...newMatches(preview.plan, fields)];
  const changeBlock = (match: (typeof changed)[number]) =>
    h(
      'div',
      { class: 'ch', testid: 'zt-import-change' },
      h('div', { class: 'top' }, h('b', {}, match.name || NO_NAME), h('span', { class: 'mono' }, match.username)),
      ...match.changes.map((c) =>
        h('div', { class: 'r' }, h('span', { class: 'k' }, FIELD_LABELS[c.field]), c.from && h('span', { class: 'old' }, c.from), h('span', { class: 'new' }, c.to)),
      ),
    );
  const list = h('div', { style: 'flex:1;overflow:auto;padding:4px 16px 12px', testid: 'zt-import-changes' }, ...changed.slice(0, SHOWN_CHANGES).map(changeBlock));
  if (changed.length > SHOWN_CHANGES) {
    const more = h('button', { class: 'link more', type: 'button', style: 'text-decoration:none', testid: 'zt-import-changes-more' }, `and ${changed.length - SHOWN_CHANGES} more`);
    more.addEventListener('click', () => {
      more.remove();
      list.append(...changed.slice(SHOWN_CHANGES).map(changeBlock));
    });
    list.append(more);
  }
  const confirm = h('button', { class: 'btn pri', type: 'button', testid: 'zt-import-confirm' }, `Import ${plural(changed.length, 'change', 'changes')}`);
  const error = h('p', { class: 'err', role: 'alert', style: 'margin:0 16px' });
  confirm.addEventListener('click', () => {
    void (async () => {
      confirm.disabled = true;
      try {
        const { result } = await call<{ result: ImportResult }>({ type: 'applyImport', text, fields });
        showResult(result);
      } catch (e) {
        error.textContent = messageOf(e);
        confirm.disabled = false;
      }
    })();
  });
  show(
    h(
      'div',
      { class: 'screen', testid: 'zt-import-confirm-screen' },
      bar(`Import ${plural(changed.length, 'change', 'changes')}?`, () => showNbPreview(fileName, text, preview, fields)),
      list,
      error,
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', testid: 'zt-import-keep', onclick: () => void showMain() }, 'Keep my list as it is'), confirm),
    ),
  );
}

/** Each new person as a change block: no username yet, and every ticked field that has a value. */
function newMatches(plan: NbPlan, fields: DetailField[]): { username: string; name: string; changes: NbPlan['matched'][number]['changes'] }[] {
  return plan.newPeople.map((p) => ({
    username: `New · ${p.email}`,
    name: fields.includes('name') ? p.values.name : '',
    changes: fields.filter((f) => p.values[f] !== '').map((f) => ({ field: f, from: '', to: p.values[f] })),
  }));
}

function changedMatches(plan: NbPlan, fields: DetailField[]): { username: string; name: string; changes: NbPlan['matched'][number]['changes'] }[] {
  return plan.matched
    .map((m) => ({ username: m.username, name: m.name, changes: m.changes.filter((c) => fields.includes(c.field)) }))
    .filter((m) => m.changes.length > 0);
}

function showResult(result: ImportResult): void {
  const nb = result.kind === 'nationbuilder';
  const title = nb && result.added === 0 ? `${plural(result.updated, 'person', 'people')} updated` : `${plural(result.added + result.updated, 'person', 'people')} imported`;
  const tile = (value: number, label: string, colour?: string) =>
    h('div', { class: 'st', testid: `zt-result-${label.toLowerCase()}` }, h('b', colour ? { style: `color:${colour}` } : {}, String(value)), h('span', {}, label));
  const tiles = [tile(result.added, 'Added', '#0F766E'), tile(result.updated, 'Updated', '#0F766E'), tile(result.unchanged, 'Unchanged'), tile(result.skipped.length, 'Skipped', '#B42318')];
  show(
    h(
      'div',
      { class: 'screen', testid: 'zt-import-result' },
      bar('Import complete', () => void showMain()),
      h(
        'div',
        { class: 'body' },
        h('div', { class: 'done' }, h('div', { class: 'c' }, svg('check', 18, 2.4)), h('div', { class: 't' }, title)),
        h('div', { class: 'tiles' }, ...tiles),
        result.skipped.length > 0 &&
          h(
            'div',
            { testid: 'zt-import-skipped' },
            h('div', { class: 'label', style: 'margin-bottom:2px' }, 'Skipped rows'),
            ...result.skipped.map((s) =>
              h(
                'div',
                { class: 'sk', testid: 'zt-skipped-row', 'data-row': s.row },
                h('span', { class: 'n' }, `Row ${s.row}`),
                h('span', { class: (s.label ?? '').includes('@') ? 'mono' : '' }, s.label ?? ''),
                h('span', { class: 'why' }, s.reason),
              ),
            ),
          ),
      ),
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn', type: 'button', testid: 'zt-export-backup', onclick: () => void startExport() }, 'Export backup'),
        h('button', { class: 'btn pri', type: 'button', testid: 'zt-import-done', onclick: () => void showMain() }, 'Done'),
      ),
    ),
  );
}

/** A `.ztbackup` file opens with a password, the recovery code or a security key held in the file. */
function showBackupSecret(fileName: string, text: string, backup: Backup): void {
  const error = h('p', { class: 'err', testid: 'zt-backup-error', role: 'alert' });
  const importWith = async (secret: SecretMessage): Promise<void> => {
    const { result } = await call<{ result: ImportResult }>({ type: 'importBackup', text, secret });
    showResult(result);
  };
  const back = (): void => showBackupSecret(fileName, text, backup);
  const keys = backup.methods.filter((m) => m.type === 'passkey' && m.kind === 'cross-platform');
  const buttons: HTMLElement[] = [];
  if (keys.length > 0) {
    buttons.push(
      h(
        'button',
        {
          class: 'btn big',
          type: 'button',
          testid: 'zt-backup-key',
          onclick: () =>
            void (async () => {
              error.textContent = '';
              try {
                const asserted = await assertPasskey(keys.map((m) => ({ credentialId: m.type === 'passkey' ? m.credentialId : '', prfSalt: m.type === 'passkey' ? m.prfSalt : '' })));
                await importWith({ type: 'passkey', credentialId: asserted.credentialId, prfOutput: asserted.prfOutput });
              } catch (e) {
                error.textContent = e instanceof RequestFailed ? e.message : (ceremonyError(e) ?? '');
              }
            })(),
        },
        svg('securityKey', 20, 1.8),
        'Use security key',
      ),
    );
  }
  if (backup.methods.some((m) => m.type === 'password')) {
    buttons.push(
      h(
        'button',
        {
          class: 'btn big',
          type: 'button',
          testid: 'zt-backup-password',
          onclick: () => showSecret({ title: 'Open the backup', kind: 'password', submit: 'Import', back, run: importWith }),
        },
        svg('password', 20, 1.8),
        'Use password',
      ),
    );
  }
  buttons.push(
    h(
      'button',
      {
        class: 'btn big',
        type: 'button',
        testid: 'zt-backup-recovery',
        onclick: () => showSecret({ title: 'Open the backup', kind: 'recovery', submit: 'Import', back, run: importWith }),
      },
      svg('recoveryKey', 20, 1.8),
      'Use recovery code',
    ),
  );
  buttons[0]!.classList.add('pri');
  show(
    h(
      'div',
      { class: 'screen tint', testid: 'zt-backup-open' },
      bar('Import', () => showImportChoose()),
      h(
        'div',
        { class: 'centre' },
        h('div', { class: 'disc' }, svg('fileLock', 30, 1.8)),
        h('div', { class: 'h' }, 'Open the backup'),
        h('div', { class: 'p mono', style: 'font-size:12px' }, fileName),
        h('div', { class: 'p' }, 'Use the password, the recovery code or a security key that was set up when the backup was made.'),
        h('div', { class: 'go' }, ...buttons),
        error,
      ),
    ),
  );
}

// ---------------------------------------------------------------- export

async function startExport(): Promise<void> {
  await refreshState();
  if (checkIsRecent(state)) {
    showExport();
  } else {
    showReauth(showExport);
  }
}

function showReauth(next: () => void): void {
  const error = h('p', { class: 'err', testid: 'zt-reauth-error', role: 'alert' });
  const done = async (): Promise<void> => {
    await refreshState();
    next();
  };
  const buttons = unlockButtons(
    'check',
    { hello: 'Confirm with Windows Hello', key: 'Use security key', password: 'Use password' },
    { hello: 'zt-reauth-hello', key: 'zt-reauth-key', password: 'zt-reauth-password' },
    () =>
      showSecret({
        title: 'Confirm it is you',
        kind: 'password',
        submit: 'Confirm',
        back: () => showReauth(next),
        run: async (secret) => {
          await call({ type: 'check', secret });
          await done();
        },
      }),
    done,
    error,
  );
  const last = state.lastCheckAt === null ? 'Not confirmed yet.' : `Last confirmed ${minutesAgo(state.lastCheckAt, state.now)}.`;
  show(
    h(
      'div',
      { class: 'screen tint', testid: 'zt-reauth' },
      bar('Export backup', () => void showMain()),
      h(
        'div',
        { class: 'centre' },
        h('div', { class: 'disc' }, svg('shieldUser', 30, 1.8)),
        h('div', { class: 'h' }, 'Confirm it is you'),
        h('div', { class: 'p' }, `${last} Export needs a check in the last 5 minutes.`),
        h('div', { class: 'go' }, ...buttons),
        error,
      ),
    ),
  );
}

function showExport(): void {
  const today = new Date(state.now).toISOString().slice(0, 10);
  const error = h('p', { class: 'err', role: 'alert', style: 'margin:0' });
  const save = h('button', { class: 'btn pri', type: 'button', testid: 'zt-export-save' }, svg('download'), 'Save file');
  save.addEventListener('click', () => {
    void (async () => {
      save.disabled = true;
      try {
        const { fileName, text } = await call<{ fileName: string; text: string }>({ type: 'exportBackup' });
        saveFile(fileName, text);
        await showMain();
      } catch (e) {
        if (e instanceof RequestFailed && e.code === 'check-needed') {
          await refreshState();
          showReauth(showExport);
          return;
        }
        error.textContent = messageOf(e);
        save.disabled = false;
      }
    })();
  });
  show(
    h(
      'div',
      { class: 'screen', testid: 'zt-export' },
      bar('Export backup', () => void showMain()),
      h(
        'div',
        { class: 'body', style: 'gap:12px' },
        h(
          'div',
          { style: 'display:flex;justify-content:space-between;font-size:13px' },
          h('span', {}, peopleLabel(state.peopleCount ?? 0)),
          h('span', { style: 'color:#0B4F49' }, `Confirmed ${minutesAgo(state.lastCheckAt ?? state.now, state.now)}`),
        ),
        h(
          'div',
          { class: 'opt' },
          svg('fileLock', 20, 2, '#0F766E'),
          h('div', {}, h('b', {}, 'Encrypted backup'), h('span', {}, 'Opens with your password, recovery code or security key, on any PC')),
        ),
        h(
          'div',
          { style: 'display:flex;flex-direction:column;gap:6px' },
          h('span', { style: 'font-size:12px;font-weight:600;color:#30353C' }, 'File name'),
          h('div', { class: 'fname mono' }, `zero-trust-translator-${today}.ztbackup`),
        ),
        h('div', { class: 'note ok' }, svg('lock', 18), h('span', {}, 'Encrypted on this computer before it is saved. Windows Hello cannot open it on another PC.')),
        error,
      ),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', testid: 'zt-export-cancel', onclick: () => void showMain() }, 'Cancel'), save),
    ),
  );
}

// ---------------------------------------------------------------- start

function route(): void {
  if (state.phase === 'setup') {
    // A passkey made in the unlock tab, after the popup closed, goes on to the recovery code screen.
    if (state.methods.some((m) => m.type !== 'recovery')) {
      void showRecovery();
    } else {
      void showSetup();
    }
  } else if (state.phase === 'locked') {
    showLock();
  } else {
    void showMain();
  }
}

async function start(): Promise<void> {
  await refreshState();
  route();
}

void start();
