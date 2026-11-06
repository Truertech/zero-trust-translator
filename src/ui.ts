/**
 * Small DOM helpers shared by the popup, the options page and the unlock
 * tab (#3797). Every text goes in with `textContent`; only the static icon
 * markup of `icons.ts` goes in as HTML.
 */
import { icon, type IconName } from './icons';
import { CEREMONY_PORT, CHECK_WINDOW_MS, send, type CeremonyOp, type MethodView, type Response, type SecretMessage, type StateView } from './messages';
import type { PasskeyKind } from './vault';
import { NO_PRF_MESSAGE, NoPrfError, assertPasskey, registerPasskey, type RegisteredPasskey } from './webauthn';

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>;

/** Makes an element. `on<event>` attributes become listeners; `false`, `null` and `undefined` values are left out. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) {
      continue;
    }
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'class') {
      el.className = String(value);
    } else if (key === 'testid') {
      el.setAttribute('data-testid', String(value));
    } else if (key === 'value' && 'value' in el) {
      (el as HTMLInputElement).value = String(value);
    } else if (key === 'checked' || key === 'disabled') {
      (el as HTMLInputElement)[key] = value === true;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

function append(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    el.append(child);
  }
}

/** A `<span>` that holds one icon of the boards. */
export function svg(name: IconName, size = 16, strokeWidth = 2, stroke?: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'i';
  span.innerHTML = icon(name, size, strokeWidth, stroke);
  return span;
}

/**
 * A link of the page's hidden `#links` block. The addresses live in the HTML
 * only: `scripts/check-no-network.mjs` refuses a remote URL in a bundle.
 */
export function pageLink(name: 'source' | 'release'): string {
  return document.querySelector(`#links [data-link="${name}"]`)?.getAttribute('href') ?? '#';
}

const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** "6 Nov 2026". */
export function formatDate(iso: string): string {
  return DATE.format(new Date(iso));
}

/** "today", "yesterday" or "6 Nov 2026", for when a key was last used. */
export function formatDay(iso: string, now: number): string {
  const day = (t: number): string => new Date(t).toDateString();
  if (day(Date.parse(iso)) === day(now)) {
    return 'today';
  }
  if (day(Date.parse(iso)) === day(now - 86_400_000)) {
    return 'yesterday';
  }
  return formatDate(iso);
}

/** "just now", "1 minute ago", "22 minutes ago". */
export function minutesAgo(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
}

export function autoLockLabel(minutes: number): string {
  if (minutes >= 60) {
    return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
  }
  return `${minutes} min`;
}

export function peopleLabel(count: number): string {
  return count === 1 ? '1 person' : `${count} people`;
}

/** Whether a guarded action can run now without a new check. */
export function checkIsRecent(state: StateView): boolean {
  return state.lastCheckAt !== null && state.now - state.lastCheckAt <= CHECK_WINDOW_MS;
}

export function passkeys(state: StateView, kind?: PasskeyKind): MethodView[] {
  return state.methods.filter((m) => m.type === 'passkey' && (kind === undefined || m.kind === kind));
}

export function hasPassword(state: StateView): boolean {
  return state.methods.some((m) => m.type === 'password');
}

/**
 * Runs a Windows Hello or security key dialog with the ceremony port open.
 * If this page closes while the dialog runs (a popup loses focus), the
 * service worker opens the same request in `unlock.html`.
 */
export async function withCeremony<T>(op: CeremonyOp, kind: PasskeyKind, run: () => Promise<T>): Promise<T> {
  const port = chrome.runtime.connect({ name: CEREMONY_PORT });
  port.postMessage({ op, kind });
  try {
    return await run();
  } finally {
    port.postMessage({ done: true });
    port.disconnect();
  }
}

/** Asks one of the passkeys of `kind` and returns the secret for the service worker. */
export async function passkeySecret(state: StateView, kind: PasskeyKind): Promise<SecretMessage> {
  const asserted = await assertPasskey(passkeys(state, kind).map((m) => ({ credentialId: m.credentialId ?? '', prfSalt: m.prfSalt ?? '' })));
  return { type: 'passkey', credentialId: asserted.credentialId, prfOutput: asserted.prfOutput };
}

/** Makes a new passkey, with a name for board 18. */
export async function newPasskey(kind: PasskeyKind, name: string): Promise<RegisteredPasskey & { name: string }> {
  return { ...(await registerPasskey(kind)), name };
}

/** The text to show for a failed WebAuthn dialog. The admin closing the dialog shows nothing. */
export function ceremonyError(error: unknown): string | null {
  if (error instanceof NoPrfError) {
    return NO_PRF_MESSAGE;
  }
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    return 'The check was cancelled or timed out. Try again.';
  }
  if (error instanceof DOMException && error.name === 'InvalidStateError') {
    return 'This key is already set up.';
  }
  return error instanceof Error ? error.message : String(error);
}

/** Sends a request and throws its message when it fails. */
export async function call<T = object>(request: Parameters<typeof send>[0]): Promise<T> {
  const response = (await send<T>(request)) as Response<T>;
  if (!response.ok) {
    throw new RequestFailed(response.error, response.message);
  }
  return response;
}

export class RequestFailed extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RequestFailed';
  }
}

export async function getState(): Promise<StateView> {
  return (await call<{ state: StateView }>({ type: 'getState' })).state;
}

/** Saves text as a local file through a download link. No network: the URL is a `blob:` of this page. */
export function saveFile(fileName: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = h('a', { href: url, download: fileName, style: 'display:none' });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
