/**
 * The options page, "Security". Lists the unlock
 * methods, the lock settings and the recovery code, and holds "Delete my
 * list". Every change to an unlock method, a new recovery code and the
 * delete need a check in the last 5 minutes; the service worker refuses
 * them without one, and this page asks for the check first.
 */
import { AUTO_LOCK_CHOICES, type MethodView, type SecretMessage, type StateView } from './messages';
import { passwordForm } from './password-form';
import {
  RequestFailed,
  autoLockLabel,
  call,
  ceremonyError,
  checkIsRecent,
  formatDate,
  formatDay,
  getState,
  h,
  hasPassword,
  newPasskey,
  passkeySecret,
  passkeys,
  peopleLabel,
  svg,
} from './ui';
import { recoveryCodeGroups, type PasskeyKind } from './vault';
import { platformAuthenticatorAvailable } from './webauthn';

const root = document.getElementById('app') as HTMLElement;

let state: StateView;
let helloAvailable = false;
/** The open inline panel: one at a time, under the row it belongs to. */
let panel: { row: string; element: HTMLElement } | null = null;
let notice = '';

function messageOf(error: unknown): string {
  return error instanceof RequestFailed ? error.message : (ceremonyError(error) ?? '');
}

async function reload(): Promise<void> {
  state = await getState();
  render();
}

function openPanel(row: string, element: HTMLElement): void {
  panel = { row, element };
  render();
  element.querySelector<HTMLElement>('input, button')?.focus();
}

function closePanel(): void {
  panel = null;
}

function panelFor(row: string): HTMLElement | false {
  return panel?.row === row && panel.element;
}

/**
 * Runs a guarded action now when the last check is recent, and otherwise
 * opens the check panel first. The service worker enforces the same rule.
 */
function guarded(row: string, action: () => void): void {
  if (checkIsRecent(state)) {
    action();
    return;
  }
  openPanel(row, checkPanel(action));
}

/** The check on this page: Windows Hello, a security key or the password, then the action. */
function checkPanel(then: () => void): HTMLElement {
  const error = h('p', { class: 'err', role: 'alert', style: 'margin:0', testid: 'zt-reauth-error' });
  const done = async (secret: SecretMessage): Promise<void> => {
    await call({ type: 'check', secret });
    state = await getState();
    then();
  };
  const withKey = (kind: PasskeyKind) => async (): Promise<void> => {
    error.textContent = '';
    try {
      await done(await passkeySecret(state, kind));
    } catch (e) {
      error.textContent = messageOf(e);
    }
  };
  const password = h('input', { type: 'password', 'aria-label': 'Password', autocomplete: 'current-password', testid: 'zt-password-field' });
  const passwordRow =
    hasPassword(state) &&
    h(
      'form',
      {
        class: 'row',
        onsubmit: (event: Event) => {
          event.preventDefault();
          error.textContent = '';
          void done({ type: 'password', password: password.value }).catch((e: unknown) => (error.textContent = messageOf(e)));
        },
      },
      h('div', { class: 'f', style: 'flex:1;min-width:200px' }, password),
      h('button', { class: 'btn pri', type: 'submit', testid: 'zt-password-submit' }, 'Confirm'),
    );
  const last = state.lastCheckAt === null ? '' : ` Last confirmed ${formatMinutes(state.now - state.lastCheckAt)} ago.`;
  return h(
    'div',
    { class: 'panel reauth', testid: 'zt-reauth' },
    h('div', { class: 'p' }, h('b', {}, 'Confirm it is you. '), `This change needs a check in the last 5 minutes.${last}`),
    h(
      'div',
      { class: 'row' },
      passkeys(state, 'platform').length > 0 && h('button', { class: 'btn', type: 'button', testid: 'zt-reauth-hello', onclick: () => void withKey('platform')() }, svg('hello', 16, 1.8), 'Windows Hello'),
      passkeys(state, 'cross-platform').length > 0 &&
        h('button', { class: 'btn', type: 'button', testid: 'zt-reauth-key', onclick: () => void withKey('cross-platform')() }, svg('securityKey', 16, 1.8), 'Security key'),
      h('button', { class: 'btn', type: 'button', testid: 'zt-reauth-cancel', onclick: () => (closePanel(), render()) }, 'Cancel'),
    ),
    passwordRow,
    error,
  );
}

function formatMinutes(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

function unlockingCount(): number {
  return state.methods.filter((m) => m.type !== 'recovery').length;
}

function transportLabel(method: MethodView): string {
  const transports = method.transports ?? [];
  if (transports.includes('usb')) {
    return 'USB key';
  }
  if (transports.includes('nfc')) {
    return 'NFC key';
  }
  if (transports.includes('ble')) {
    return 'Bluetooth key';
  }
  return 'Security key';
}

function removeButton(method: MethodView): HTMLElement {
  const last = unlockingCount() <= 1;
  const btn = h(
    'button',
    {
      class: 'btn dng',
      type: 'button',
      testid: 'zt-remove-method',
      'data-method-type': method.type,
      'data-method-id': method.id,
      disabled: last,
      title: last ? 'The last way to unlock the list cannot be removed' : false,
    },
    'Remove',
  );
  btn.addEventListener('click', () =>
    guarded(`method-${method.id}`, () => {
      void (async () => {
        btn.disabled = true;
        try {
          await call({ type: 'removeMethod', id: method.id });
          closePanel();
          notice = method.type === 'password' ? 'Password removed.' : `${method.name ?? 'Key'} removed.`;
        } catch (e) {
          notice = messageOf(e);
        }
        await reload();
      })();
    }),
  );
  return btn;
}

function passkeyRow(method: MethodView): HTMLElement {
  const hello = method.kind === 'platform';
  const used = method.lastUsedAt ? ` · last used ${formatDay(method.lastUsedAt, state.now)}` : '';
  const title = hello ? 'Windows Hello' : `Security key “${method.name ?? 'Security key'}”`;
  const where = hello ? 'This PC' : transportLabel(method);
  return h(
    'div',
    { class: 'r', testid: 'zt-method', 'data-method-type': 'passkey' },
    h('div', { class: 'ic' }, svg(hello ? 'hello' : 'securityKey', 20, 1.8)),
    h('div', { class: 't' }, h('b', {}, title), h('span', {}, `${where} · added ${formatDate(method.createdAt)}${used}`)),
    removeButton(method),
    panelFor(`method-${method.id}`),
  );
}

function addKeyPanel(): HTMLElement {
  const error = h('p', { class: 'err', role: 'alert', style: 'margin:0' });
  const name = h('input', { type: 'text', value: 'Security key', 'aria-label': 'Key name', maxlength: 60, testid: 'zt-add-key-name' });
  const hasHello = passkeys(state, 'platform').length > 0;
  const helloBtn = h('button', { class: 'btn', type: 'button', testid: 'zt-add-hello' }, svg('hello', 16, 1.8), 'Add Windows Hello');
  const keyBtn = h('button', { class: 'btn', type: 'button', testid: 'zt-add-security-key' }, svg('securityKey', 16, 1.8), 'Add security key');
  const add = async (kind: PasskeyKind): Promise<void> => {
    error.textContent = '';
    helloBtn.disabled = true;
    keyBtn.disabled = true;
    try {
      const passkey = await newPasskey(kind, kind === 'platform' ? 'Windows Hello' : name.value);
      await call({ type: 'addPasskey', passkey });
      closePanel();
      notice = kind === 'platform' ? 'Windows Hello added.' : `${name.value.trim() || 'Security key'} added.`;
      await reload();
    } catch (e) {
      if (e instanceof RequestFailed && e.code === 'check-needed') {
        state = await getState();
        openPanel('add-key', checkPanel(() => openPanel('add-key', addKeyPanel())));
        return;
      }
      error.textContent = messageOf(e);
      helloBtn.disabled = false;
      keyBtn.disabled = false;
    }
  };
  helloBtn.addEventListener('click', () => void add('platform'));
  keyBtn.addEventListener('click', () => void add('cross-platform'));
  return h(
    'div',
    { class: 'panel', testid: 'zt-add-key' },
    h('div', { class: 'p' }, 'Choose what to add. Windows asks you to confirm with your face, fingerprint, PIN or key.'),
    helloAvailable && !hasHello && h('div', { class: 'row' }, helloBtn),
    h(
      'div',
      { class: 'row' },
      h('div', { class: 'f', style: 'flex:1;min-width:200px' }, name),
      keyBtn,
      h('button', { class: 'btn', type: 'button', testid: 'zt-add-key-cancel', onclick: () => (closePanel(), render()) }, 'Cancel'),
    ),
    error,
  );
}

function passwordPanel(): HTMLElement {
  const error = h('p', { class: 'err', role: 'alert', style: 'margin:0' });
  const save = h('button', { class: 'btn pri', type: 'button', testid: 'zt-password-save', disabled: true }, 'Save password');
  const form = passwordForm((ok) => (save.disabled = !ok));
  save.addEventListener('click', () => {
    void (async () => {
      save.disabled = true;
      try {
        await call({ type: 'setPassword', password: form.value() });
        closePanel();
        notice = 'Password saved.';
        await reload();
      } catch (e) {
        error.textContent = messageOf(e);
        save.disabled = false;
      }
    })();
  });
  return h(
    'div',
    { class: 'panel', testid: 'zt-password-panel' },
    h('div', { style: 'max-width:360px' }, form.element),
    h('div', { class: 'row' }, save, h('button', { class: 'btn', type: 'button', testid: 'zt-password-cancel', onclick: () => (closePanel(), render()) }, 'Cancel')),
    error,
  );
}

function recoveryPanel(code: string): HTMLElement {
  const saved = h('input', { type: 'checkbox', testid: 'zt-recovery-saved' });
  const done = h('button', { class: 'btn pri', type: 'button', testid: 'zt-finish', disabled: true, onclick: () => (closePanel(), render()) }, 'Done');
  saved.addEventListener('change', () => (done.disabled = !saved.checked));
  return h(
    'div',
    { class: 'panel', testid: 'zt-new-recovery-panel' },
    h('div', { class: 'p' }, 'Your new recovery code. Shown once. The old code no longer works.'),
    h('div', { class: 'codes mono', testid: 'zt-recovery-code' }, ...recoveryCodeGroups(code).map((g) => h('div', { class: 'g' }, g))),
    h('label', { class: 'saved' }, saved, 'I have saved the recovery code'),
    h('div', { class: 'row' }, done),
  );
}

function newRecoveryButton(): HTMLElement {
  const btn = h('button', { class: 'btn', type: 'button', testid: 'zt-new-recovery' }, 'Make a new code');
  btn.addEventListener('click', () =>
    guarded('recovery', () => {
      void (async () => {
        btn.disabled = true;
        try {
          const { code } = await call<{ code: string }>({ type: 'newRecoveryCode' });
          state = await getState();
          openPanel('recovery', recoveryPanel(code));
        } catch (e) {
          notice = messageOf(e);
          await reload();
        }
      })();
    }),
  );
  return btn;
}

function deletePanel(): HTMLElement {
  const error = h('p', { class: 'err', role: 'alert', style: 'margin:0' });
  const confirm = h('button', { class: 'btn dng', type: 'button', testid: 'zt-delete-confirm' }, 'Delete my list');
  confirm.addEventListener('click', () =>
    void (async () => {
      confirm.disabled = true;
      try {
        await call({ type: 'deleteAll' });
        closePanel();
        notice = 'Your list is deleted.';
        await reload();
      } catch (e) {
        error.textContent = messageOf(e);
        confirm.disabled = false;
      }
    })(),
  );
  return h(
    'div',
    { class: 'panel', testid: 'zt-delete-panel' },
    h('div', { class: 'p' }, `Delete ${peopleLabel(state.peopleCount ?? 0)} from this computer? This cannot be undone. Your unlock methods stay.`),
    h(
      'div',
      { class: 'row' },
      confirm,
      h('button', { class: 'btn', type: 'button', testid: 'zt-delete-cancel', onclick: () => (closePanel(), render()) }, 'Cancel'),
    ),
    error,
  );
}

function section(title: string, ...rows: (Node | false)[]): HTMLElement {
  return h('section', {}, h('h2', { class: 'h' }, title), h('div', { class: 'card' }, ...rows));
}

function header(encrypted: boolean): HTMLElement {
  return h(
    'div',
    { class: 'top' },
    h('div', { class: 'logo' }, svg('shieldCheck', 20, 2.2)),
    h('div', { style: 'flex:1' }, h('h1', {}, 'Security'), h('div', { class: 'sub', testid: 'zt-version' }, `Zero Trust Translator · v${state.version}`)),
    h('span', { class: encrypted ? 'on' : 'on off' }, encrypted ? 'List encrypted' : 'Not set up'),
  );
}

function renderUnlocked(): HTMLElement {
  const password = state.methods.find((m) => m.type === 'password');
  const recovery = state.methods.find((m) => m.type === 'recovery');
  const select = h('select', { id: 'al', class: 'btn', testid: 'zt-auto-lock' }, ...AUTO_LOCK_CHOICES.map((m) => h('option', { value: m }, autoLockLabel(m).replace('min', 'minutes'))));
  select.value = String(state.settings.autoLockMinutes);
  select.addEventListener('change', () => void call({ type: 'setSettings', autoLockMinutes: Number(select.value) }).then(reload));
  const pcLock = h('button', {
    class: 'sw',
    type: 'button',
    'aria-label': 'Lock when this PC locks',
    'aria-pressed': state.settings.lockWhenPcLocks ? 'true' : 'false',
    testid: 'zt-lock-when-pc-locks',
    onclick: () => void call({ type: 'setSettings', lockWhenPcLocks: !state.settings.lockWhenPcLocks }).then(reload),
  });
  const recoveryUse = recovery?.usedAt ? `used ${formatDate(recovery.usedAt)}` : 'not used';
  return h(
    'div',
    { class: 'wrap' },
    header(true),
    notice && h('div', { class: 'msg', role: 'status', testid: 'zt-notice' }, notice),
    section(
      'Passkeys and security keys',
      ...passkeys(state).map(passkeyRow),
      h(
        'div',
        { class: 'r' },
        h('button', { class: 'btn', type: 'button', testid: 'zt-add-method', onclick: () => guarded('add-key', () => openPanel('add-key', addKeyPanel())) }, svg('plus'), 'Add Windows Hello or security key'),
        panelFor('add-key'),
      ),
    ),
    section(
      'Password',
      password
        ? h(
            'div',
            { class: 'r', testid: 'zt-method', 'data-method-type': 'password' },
            h('div', { class: 'ic' }, svg('password', 20, 1.8)),
            h('div', { class: 't' }, h('b', {}, 'Password'), h('span', {}, `Set ${formatDate(password.createdAt)} · also opens encrypted backups`)),
            h('button', { class: 'btn', type: 'button', testid: 'zt-change-password', onclick: () => guarded('password', () => openPanel('password', passwordPanel())) }, 'Change password'),
            removeButton(password),
            panelFor('password') || panelFor(`method-${password.id}`),
          )
        : h(
            'div',
            { class: 'r' },
            h('div', { class: 'ic' }, svg('password', 20, 1.8)),
            h('div', { class: 't' }, h('b', {}, 'Password'), h('span', {}, 'Not set')),
            h('button', { class: 'btn', type: 'button', testid: 'zt-change-password', onclick: () => guarded('password', () => openPanel('password', passwordPanel())) }, 'Add password'),
            panelFor('password'),
          ),
    ),
    section(
      'Locking',
      h('div', { class: 'r' }, h('div', { class: 't' }, h('label', { for: 'al' }, h('b', {}, 'Lock after')), h('span', {}, 'No activity in Chrome')), select),
      h('div', { class: 'r' }, h('div', { class: 't' }, h('b', {}, 'Lock when this PC locks')), pcLock),
    ),
    section(
      'Recovery',
      h(
        'div',
        { class: 'r' },
        h('div', { class: 'ic' }, svg('recoveryKey', 20, 1.8)),
        h('div', { class: 't' }, h('b', {}, 'Recovery code'), h('span', {}, recovery ? `Made ${formatDate(recovery.createdAt)} · ${recoveryUse}` : 'Not made')),
        newRecoveryButton(),
        panelFor('recovery'),
      ),
      h(
        'div',
        { class: 'r' },
        h('div', { class: 't' }, h('b', {}, 'Delete my list'), h('span', {}, 'Removes every person from this computer. Export a backup first.')),
        h('button', { class: 'btn dng', type: 'button', testid: 'zt-delete-list', onclick: () => guarded('delete', () => openPanel('delete', deletePanel())) }, svg('trash'), 'Delete my list'),
        panelFor('delete'),
      ),
      h('div', { class: 'r' }, h('div', { class: 't' }, h('b', {}, 'Encryption'), h('span', {}, 'AES-256-GCM · password stretched with PBKDF2-SHA-256, 600,000 rounds'))),
    ),
  );
}

function renderLocked(): HTMLElement {
  const error = h('p', { class: 'err', role: 'alert', style: 'margin:0', testid: 'zt-unlock-error' });
  const unlock = async (secret: SecretMessage): Promise<void> => {
    await call({ type: 'unlock', secret });
    await reload();
  };
  const withKey = (kind: PasskeyKind) => async (): Promise<void> => {
    error.textContent = '';
    try {
      await unlock(await passkeySecret(state, kind));
    } catch (e) {
      error.textContent = messageOf(e);
    }
  };
  const password = h('input', { type: 'password', 'aria-label': 'Password', autocomplete: 'current-password', testid: 'zt-password-field' });
  return h(
    'div',
    { class: 'wrap' },
    header(true),
    section(
      'Locked',
      h(
        'div',
        { class: 'r', testid: 'zt-locked' },
        h('div', { class: 'ic' }, svg('lock', 20, 1.8)),
        h('div', { class: 't' }, h('b', {}, 'Your list is locked'), h('span', {}, 'Unlock it to change these settings')),
        passkeys(state, 'platform').length > 0 && h('button', { class: 'btn', type: 'button', testid: 'zt-unlock-hello', onclick: () => void withKey('platform')() }, svg('hello', 16, 1.8), 'Windows Hello'),
        passkeys(state, 'cross-platform').length > 0 &&
          h('button', { class: 'btn', type: 'button', testid: 'zt-unlock-key', onclick: () => void withKey('cross-platform')() }, svg('securityKey', 16, 1.8), 'Security key'),
      ),
      hasPassword(state) &&
        h(
          'form',
          {
            class: 'r',
            onsubmit: (event: Event) => {
              event.preventDefault();
              error.textContent = '';
              void unlock({ type: 'password', password: password.value }).catch((e: unknown) => (error.textContent = messageOf(e)));
            },
          },
          h('div', { class: 'f', style: 'flex:1;min-width:200px' }, password),
          h('button', { class: 'btn pri', type: 'submit', testid: 'zt-password-submit' }, 'Unlock'),
        ),
      h('div', { class: 'r' }, error),
    ),
  );
}

function renderSetup(): HTMLElement {
  return h(
    'div',
    { class: 'wrap' },
    header(false),
    section('Set up', h('div', { class: 'r', testid: 'zt-options-setup' }, h('div', { class: 't' }, h('b', {}, 'Finish setup in the extension popup first'), h('span', {}, 'Click the Zero Trust Translator icon in the Chrome toolbar.')))),
  );
}

function render(): void {
  const content = state.phase === 'setup' ? renderSetup() : state.phase === 'locked' ? renderLocked() : renderUnlocked();
  root.replaceChildren(h('div', { class: 'page', testid: 'zt-options' }, content));
}

async function start(): Promise<void> {
  helloAvailable = await platformAuthenticatorAvailable();
  await reload();
  // The list can lock or unlock from the popup while this page is open.
  chrome.storage.session.onChanged.addListener(() => {
    void getState().then((next) => {
      if (next.phase !== state.phase) {
        closePanel();
        state = next;
        render();
      }
    });
  });
}

void start();
