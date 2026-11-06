/**
 * The content script. Finds every `data-zt-id` marker (#3785's marker
 * contract) and draws the real name over it, on this computer only.
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
 * Content scripts run in an isolated world (a JS realm that shares the DOM
 * with the page but not its JS objects), so even `window` and its event
 * listeners in the page's world never receive what this script does.
 */
import { getAllAsMap, mapFromChange, STORAGE_KEY_FOR_TESTS } from './store';

const MARKER_SELECTOR = '[data-zt-id]';
// `WeakMap`, never a plain `Map` or `Set`: a page like this one replaces
// marker elements often (React re-renders the members list on every page the
// admin visits in a session left open all day). A `Set` of elements would
// keep every removed element reachable forever, so it would never free, and
// an admin's long session would grow it without bound. A `WeakMap` drops its
// entry the moment nothing else holds the element.
const nameSpans = new WeakMap<Element, HTMLSpanElement>();

let people: Map<string, string> = new Map();

function markerId(el: Element): string | null {
  const raw = el.getAttribute('data-zt-id');
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function render(el: Element): void {
  const id = markerId(el);
  if (id === null) {
    return;
  }
  const name = people.get(id);
  let span = nameSpans.get(el);
  if (!span) {
    if (name === undefined) {
      return; // Never matched: leave the page's own light DOM showing, as it drew it.
    }
    // Attaching a shadow root with no `<slot>` stops the page's own light-DOM
    // text from rendering at all, for good — a shadow root cannot be
    // detached. So the marker's own text is read and kept here BEFORE that
    // happens, as the fallback to show if the person is later deleted from
    // the list: without it, a deleted person's name would stay drawn in
    // forever, because nothing would be left to revert to.
    const fallback = el.textContent ?? '';
    const shadow = el.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = '#zt-name::before { content: attr(data-zt-name); }';
    span = document.createElement('span');
    span.id = 'zt-name';
    span.dataset.ztFallback = fallback;
    shadow.append(style, span);
    nameSpans.set(el, span);
  }
  span.setAttribute('data-zt-name', name ?? span.dataset['ztFallback'] ?? '');
}

function scan(root: ParentNode): void {
  root.querySelectorAll(MARKER_SELECTOR).forEach((el) => {
    render(el);
  });
}

function observeAdditions(): void {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) {
          return;
        }
        if (node.matches(MARKER_SELECTOR)) {
          render(node);
        }
        scan(node);
      });
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

async function start(): Promise<void> {
  people = await getAllAsMap();
  scan(document);
  observeAdditions();
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !(STORAGE_KEY_FOR_TESTS in changes)) {
      return;
    }
    people = mapFromChange(changes[STORAGE_KEY_FOR_TESTS]);
    // Re-scans every marker in the page now, rather than keeping a separate
    // list of markers seen so far: this runs only on a storage edit (the
    // admin changes the list in the popup), never per DOM mutation, so the
    // cost of one querySelectorAll over the page is not a hot path.
    scan(document);
  });
}

void start();
