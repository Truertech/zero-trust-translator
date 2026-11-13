/**
 * The unlock tab. A Windows Hello or security key dialog closes the
 * popup when the popup loses focus. The service worker then opens this tab
 * with the same request (`?op=unlock&kind=platform`), and the admin finishes
 * the dialog here, in a page that keeps focus.
 */
import type { CeremonyOp, SecretMessage } from './messages';
import { RequestFailed, call, ceremonyError, getState, h, newPasskey, passkeySecret, svg } from './ui';
import type { PasskeyKind } from './vault';

const TITLES: Record<CeremonyOp, string> = {
  unlock: 'Unlock your list',
  check: 'Confirm it is you',
  setup: 'Set up your list',
  add: 'Add a way to unlock',
};

const DONE: Record<CeremonyOp, string> = {
  unlock: 'Your list is unlocked. You can close this tab.',
  check: 'Confirmed. Go back to the extension popup or the Security page.',
  setup: 'Added. Open the extension popup to finish setup.',
  add: 'Added. You can close this tab.',
};

function readRequest(): { op: CeremonyOp; kind: PasskeyKind } | null {
  const query = new URLSearchParams(location.search);
  const op = query.get('op');
  const kind = query.get('kind');
  if (op !== 'unlock' && op !== 'check' && op !== 'setup' && op !== 'add') {
    return null;
  }
  if (kind !== 'platform' && kind !== 'cross-platform') {
    return null;
  }
  return { op, kind };
}

async function run(op: CeremonyOp, kind: PasskeyKind): Promise<void> {
  const state = await getState();
  if (op === 'unlock' || op === 'check') {
    const secret: SecretMessage = await passkeySecret(state, kind);
    await call({ type: op, secret });
    return;
  }
  const passkey = await newPasskey(kind, kind === 'platform' ? 'Windows Hello' : 'Security key');
  await call(op === 'setup' ? { type: 'setupAddPasskey', passkey } : { type: 'addPasskey', passkey });
}

function render(): void {
  const root = document.getElementById('app') as HTMLElement;
  const request = readRequest();
  const message = h('p', { class: 'p', role: 'status', testid: 'zt-ceremony-done' });
  const error = h('p', { class: 'err', role: 'alert', testid: 'zt-ceremony-error' });
  if (!request) {
    error.textContent = 'This page was opened without a request. Close it and start again from the extension.';
  }
  const start = h(
    'button',
    {
      class: 'btn pri',
      type: 'button',
      testid: 'zt-ceremony-start',
      disabled: !request,
      onclick: () => {
        if (!request) {
          return;
        }
        start.disabled = true;
        error.textContent = '';
        void run(request.op, request.kind)
          .then(() => {
            message.textContent = DONE[request.op];
            start.remove();
          })
          .catch((e: unknown) => {
            error.textContent = e instanceof RequestFailed ? e.message : (ceremonyError(e) ?? '');
            start.disabled = false;
          });
      },
    },
    request?.kind === 'cross-platform' ? svg('securityKey', 16, 1.8) : svg('hello', 16, 1.8),
    'Continue',
  );
  root.replaceChildren(
    h(
      'div',
      { class: 'solo', testid: 'zt-ceremony' },
      h(
        'div',
        { class: 'box' },
        h(
          'div',
          { class: 'centre' },
          h('div', { class: 'logo' }, svg('shieldCheck', 20, 2.2)),
          h('h1', {}, request ? TITLES[request.op] : 'Zero Trust Translator'),
          h('p', { class: 'p' }, request?.kind === 'cross-platform' ? 'Continue, then touch your security key.' : 'Continue, then confirm with your face, fingerprint or PIN.'),
          message,
          error,
          start,
        ),
      ),
    ),
  );
}

render();