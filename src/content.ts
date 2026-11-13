/**
 * The content script. Finds every `data-zt-id` marker (the marker
 * contract) and draws the real name over it, on this computer only.
 *
 * The list is encrypted and only the service worker can open
 * it. This script sends the marker ids it finds (`lookupNames`) and gets
 * back the names of those ids and nothing more: never the list, never the
 * data key. While the list is locked the answer has no names, and every
 * marker shows the page's own text again.
 *
 * HOW THE NAME IS HIDDEN FROM THE PAGE'S OWN SCRIPT, TWICE OVER:
 *
 * 1. `attachShadow({ mode: 'closed' })` puts the name in a shadow tree the
 *    page cannot reach: `element.shadowRoot` reads `null` from the page's
 *    isolated world, so no page script can call `.textContent` on it, and
 *    `querySelector`/`innerHTML`/`outerHTML` of the host never see inside it.
 * 2. The name itself is never a DOM text node, even inside the shadow root.
 *    It is a CSS generated-content string (`content: attr(data-zt-name)`)
 *    read from an attribute of a `<span>` that lives INSIDE the closed
 *    shadow tree. `Element.innerText` is defined over the DOM's
 *    shadow-including tree order regardless of shadow-root mode, so a text
 *    node inside a closed shadow root WOULD still show up in
 *    `document.body.innerText` from the page. CSS generated content is not
 *    a DOM node at all, so `innerText` (and `textContent`) never see it.
 *
 * The shadow root holds a `<slot>`, so the page's own text shows through it
 * until a name is drawn, and again when the list locks or the person is
 * removed. A shadow root cannot be detached, so the slot is how a marker
 * goes back to the page's text.
 *
 * Content scripts run in an isolated world (a JS realm that shares the DOM
 * with the page but not its JS objects), so even `window` and its event
 * listeners in the page's world never receive what this script does.
 */
import { REFRESH_MESSAGE, type NamesResponse, type Request, type Response } from './messages';

const MARKER_SELECTOR = '[data-zt-id]';
const RESCAN_DELAY_MS = 150;

const SHIELD_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z"/></svg>';
const SHIELD_CHECK_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z"/><path d="M9 12l2 2 4-4"/></svg>';
const LOCK_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

// The shield, the dotted underline and the dark hover box.
const MARKER_STYLE = `
#w { position: relative; display: inline; }
#zt-name { display: none; align-items: center; gap: 5px; font-weight: 500; border-bottom: 1.5px dotted #0F766E; padding-bottom: 1px; }
#w.on #zt-name { display: inline-flex; }
#w.on slot { display: none; }
#zt-name svg { color: #0F766E; flex: none; }
#zt-name::after { content: attr(data-zt-name); }
#tip { display: none; position: absolute; left: 0; top: calc(100% + 6px); z-index: 2147483647; background: #16181D; color: #fff; border-radius: 8px; padding: 8px 10px; font: 12px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; white-space: pre; pointer-events: none; }
#tip::before { content: attr(data-zt-name); font-weight: 600; display: block; }
#tip::after { content: attr(data-zt-user) " · from your Translator list"; display: block; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; opacity: .8; margin-top: 2px; }
#w.on:hover #tip { display: block; }
`;

// The badge, fixed at the top right of the page.
const BADGE_STYLE = `
#b { position: fixed; top: 12px; right: 12px; z-index: 2147483647; display: none; align-items: center; gap: 8px; font: 12px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; border-radius: 999px; padding: 5px 12px; box-shadow: 0 1px 3px rgba(22,24,29,.12); }
#b.unlocked { display: inline-flex; color: #0B4F49; background: #E6F2EF; border: 1px solid #BFDCD6; }
#b.locked { display: inline-flex; color: #454B54; background: #fff; border: 1px solid #D5D2CA; }
#b .lock, #b .shield { display: none; }
#b.locked .lock, #b.unlocked .shield { display: inline-flex; }
#t::before { content: attr(data-zt-text); }
`;

interface MarkerParts {
  wrapper: HTMLSpanElement;
  name: HTMLSpanElement;
  tip: HTMLSpanElement;
}

// `WeakMap`, never a plain `Map` or `Set`: a page like this one replaces
// marker elements often (React re-renders the members list on every page the
// admin visits in a session left open all day). A `Set` of elements would
// keep every removed element reachable forever, so it would never free, and
// an admin's long session would grow it without bound. A `WeakMap` drops its
// entry the moment nothing else holds the element.
const markers = new WeakMap<Element, MarkerParts>();

let badge: { host: HTMLElement; box: HTMLSpanElement; text: HTMLSpanElement } | null = null;
let rescanTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

function markerId(el: Element): string | null {
  const raw = el.getAttribute('data-zt-id');
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function partsFor(el: Element): MarkerParts | null {
  const existing = markers.get(el);
  if (existing) {
    return existing;
  }
  let shadow: ShadowRoot;
  try {
    shadow = el.attachShadow({ mode: 'closed' });
  } catch {
    return null; // An element that cannot hold a shadow root keeps the page's text.
  }
  // Static markup only: no name ever goes into this string.
  shadow.innerHTML = `<style>${MARKER_STYLE}</style><span id="w"><slot></slot><span id="zt-name">${SHIELD_SVG}</span><span id="tip"></span></span>`;
  const parts: MarkerParts = {
    wrapper: shadow.getElementById('w') as HTMLSpanElement,
    name: shadow.getElementById('zt-name') as HTMLSpanElement,
    tip: shadow.getElementById('tip') as HTMLSpanElement,
  };
  markers.set(el, parts);
  return parts;
}

/** Draws the name over one marker, or shows the page's own text when there is none. */
function render(el: Element, names: Record<string, string>): boolean {
  const id = markerId(el);
  const name = id === null ? undefined : names[id];
  if (name === undefined) {
    const parts = markers.get(el);
    if (parts) {
      parts.wrapper.classList.remove('on');
      parts.name.removeAttribute('data-zt-name');
      parts.tip.removeAttribute('data-zt-name');
      parts.tip.removeAttribute('data-zt-user');
    }
    return false;
  }
  const parts = partsFor(el);
  if (!parts) {
    return false;
  }
  parts.name.setAttribute('data-zt-name', name);
  parts.tip.setAttribute('data-zt-name', name);
  parts.tip.setAttribute('data-zt-user', (el.textContent ?? '').trim() || (el.getAttribute('data-zt-id') ?? '').trim());
  parts.wrapper.classList.add('on');
  return true;
}

function ensureBadge(): NonNullable<typeof badge> {
  if (badge && badge.host.isConnected) {
    return badge;
  }
  const host = document.createElement('div');
  host.setAttribute('data-testid', 'zt-badge');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>${BADGE_STYLE}</style><span id="b" role="status"><span class="shield">${SHIELD_CHECK_SVG}</span><span class="lock">${LOCK_SVG}</span><span id="t"></span></span>`;
  document.documentElement.append(host);
  badge = { host, box: shadow.getElementById('b') as HTMLSpanElement, text: shadow.getElementById('t') as HTMLSpanElement };
  return badge;
}

function badgeText(phase: NamesResponse['phase'], shown: number, total: number): string {
  if (phase === 'unlocked') {
    return `Names shown by Zero Trust Translator · ${shown} of ${total} on this page`;
  }
  return 'Zero Trust Translator is locked · open the extension to unlock';
}

function renderBadge(phase: NamesResponse['phase'], shown: number, total: number): void {
  if (total === 0) {
    if (badge) {
      badge.box.className = '';
    }
    return;
  }
  const current = ensureBadge();
  const text = badgeText(phase, shown, total);
  current.box.className = phase === 'unlocked' ? 'unlocked' : 'locked';
  current.text.setAttribute('data-zt-text', text);
  current.box.setAttribute('aria-label', text);
}

async function lookup(ids: string[]): Promise<NamesResponse> {
  try {
    const response = (await chrome.runtime.sendMessage({ type: 'lookupNames', ids })) as Response<NamesResponse> | undefined;
    if (response && response.ok) {
      return { phase: response.phase, names: response.names };
    }
  } catch {
    // The extension was reloaded or removed: show the page's own text.
  }
  return { phase: 'locked', names: {} };
}

/** Asks the service worker for the names of every marker on the page, and redraws them all. */
async function refresh(): Promise<void> {
  const run = ++generation;
  const elements = [...document.querySelectorAll(MARKER_SELECTOR)];
  const ids = [...new Set(elements.map(markerId).filter((id): id is string => id !== null))];
  const { phase, names } = ids.length > 0 ? await lookup(ids) : { phase: 'locked' as const, names: {} };
  if (run !== generation) {
    return; // A newer refresh started while this one waited for the answer.
  }
  let shown = 0;
  for (const el of elements) {
    if (render(el, names)) {
      shown += 1;
    }
  }
  renderBadge(phase, shown, elements.length);
}

function scheduleRefresh(): void {
  if (rescanTimer !== null) {
    return;
  }
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    void refresh();
  }, RESCAN_DELAY_MS);
}

function touchesMarkers(mutations: MutationRecord[]): boolean {
  for (const mutation of mutations) {
    if (mutation.type === 'attributes') {
      return true;
    }
    for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
      if (node instanceof Element && (node.matches(MARKER_SELECTOR) || node.querySelector(MARKER_SELECTOR))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * `zt:listCodes` and `zt:encryptForSend`: the page cannot call
 * `chrome.runtime.sendMessage` itself (only an extension's own scripts can),
 * so it asks by `window.postMessage` and this script relays the one request
 * to the service worker and the one answer back. `origin` is added here,
 * from `location.origin`, never from the page's message: the page cannot
 * claim to be an origin it is not.
 */
const PAGE_MESSAGE_SOURCE = 'zero-trust-translator-page';
const EXTENSION_MESSAGE_SOURCE = 'zero-trust-translator-extension';

interface PageRequestEnvelope {
  source: typeof PAGE_MESSAGE_SOURCE;
  requestId: string;
  request: Request;
}

function isPageRequestEnvelope(data: unknown): data is PageRequestEnvelope {
  const value = data as Partial<PageRequestEnvelope> | null;
  return (
    !!value &&
    value.source === PAGE_MESSAGE_SOURCE &&
    typeof value.requestId === 'string' &&
    !!value.request &&
    typeof value.request === 'object' &&
    (value.request.type === 'zt:listCodes' || value.request.type === 'zt:encryptForSend')
  );
}

async function relayToBackground(request: Request): Promise<unknown> {
  try {
    return await chrome.runtime.sendMessage({ ...request, origin: location.origin });
  } catch {
    return { ok: false, error: 'forbidden', message: 'The extension was reloaded or removed.' };
  }
}

function startPageRelay(): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin || !isPageRequestEnvelope(event.data)) {
      return;
    }
    const { requestId, request } = event.data;
    void relayToBackground(request).then((response) => {
      window.postMessage({ source: EXTENSION_MESSAGE_SOURCE, requestId, response }, location.origin);
    });
  });
}

function start(): void {
  startPageRelay();
  void refresh();
  new MutationObserver((mutations) => {
    if (touchesMarkers(mutations)) {
      scheduleRefresh();
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-zt-id'] });
  // The service worker sends this after a lock, an unlock or a list change.
  chrome.runtime.onMessage.addListener((message: unknown) => {
    if ((message as { type?: string } | null)?.type === REFRESH_MESSAGE) {
      void refresh();
    }
  });
}

start();
