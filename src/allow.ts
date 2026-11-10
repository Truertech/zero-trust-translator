/**
 * The Allow window (#3919): board 6 for `operation: 'sms'`, board 11 for
 * `operation: 'eventInvite'`. It holds `ALLOW_PORT` open for as long as a
 * decision is pending, so the service worker is not evicted while it waits
 * for the admin — the same precedent as the ceremony port (`ui.ts`).
 * Nothing here decides what the window shows: `zt:getAllowRequest` reads
 * the request `background.ts` is holding for this window's `requestId`.
 */
import { ALLOW_PORT, type AllowRequestView, type SendOperation } from './messages';
import { RequestFailed, call, h } from './ui';

const OPERATION_TEXT: Record<SendOperation, string> = {
  sms: 'Send SMS messages',
  eventInvite: 'Send SMS event invites',
};

function readRequestId(): string | null {
  return new URLSearchParams(location.search).get('requestId');
}

function renderError(root: HTMLElement, message: string): void {
  root.replaceChildren(h('div', { class: 'screen' }, h('div', { class: 'body' }, h('p', { class: 'err', role: 'alert' }, message))));
}

function renderRequest(root: HTMLElement, requestId: string, request: AllowRequestView): void {
  const error = h('p', { class: 'err', role: 'alert', testid: 'zt-allow-error' });
  const deny = h('button', { class: 'btn', type: 'button', testid: 'zt-allow-deny' }, 'Deny');
  const allow = h('button', { class: 'btn pri', type: 'button', testid: 'zt-allow-allow' }, 'Allow');

  const decide = (decision: 'allow' | 'deny'): void => {
    deny.disabled = true;
    allow.disabled = true;
    error.textContent = '';
    // `background.ts` closes this window once it settles the decision as a
    // success: the page tears down before the reply arrives, so a rejection
    // from that is expected and ignored. A reply that arrives with
    // `ok: false` means the window did NOT close, so it must say so and let
    // the admin try again instead of leaving two disabled buttons with no
    // explanation.
    call({ type: 'zt:resolveAllow', requestId, decision }).catch((caught: unknown) => {
      deny.disabled = false;
      allow.disabled = false;
      error.textContent = caught instanceof RequestFailed ? caught.message : 'That did not work. Try again, or close this window.';
    });
  };
  deny.addEventListener('click', () => decide('deny'));
  allow.addEventListener('click', () => decide('allow'));

  root.replaceChildren(
    h(
      'div',
      { class: 'screen' },
      h('div', { class: 'hd' }, h('div', { class: 'ttl' }, request.origin)),
      h(
        'div',
        { class: 'body' },
        h('p', { class: 'p' }, 'Send encrypted phone number and name to the system for the operation'),
        h('div', { class: 'banner', testid: 'zt-allow-operation' }, OPERATION_TEXT[request.operation]),
        h('div', { class: 'ro' }, h('span', {}, 'People'), h('strong', { testid: 'zt-allow-count' }, String(request.peopleCount))),
        h('div', { class: 'note', testid: 'zt-allow-template' }, request.template),
        error,
      ),
      h('div', { class: 'actions' }, deny, allow),
    ),
  );
}

async function render(): Promise<void> {
  const root = document.getElementById('app') as HTMLElement;
  const requestId = readRequestId();
  if (!requestId) {
    renderError(root, 'This window was opened without a request. Close it.');
    return;
  }
  // Keeps the service worker alive for as long as this window is open and
  // waiting; disconnecting (this window closing) tells `background.ts`
  // nothing on its own, but the worker staying alive is what lets it still
  // answer `zt:resolveAllow`, or notice the close through `onWindowRemoved`.
  chrome.runtime.connect({ name: ALLOW_PORT });
  try {
    const { request } = await call<{ request: AllowRequestView }>({ type: 'zt:getAllowRequest', requestId });
    renderRequest(root, requestId, request);
  } catch (error) {
    renderError(root, error instanceof RequestFailed ? error.message : 'This request is no longer open. Close this window.');
  }
}

void render();
