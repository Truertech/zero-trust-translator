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
const nameSpans = new WeakMap<Element, HTMLSpanElement>();
const knownMarkers = new Set<Element>();

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
  if (name === undefined) {
    return; // "A marker whose id is not in the list stays as the page drew it."
  }
  let span = nameSpans.get(el);
  if (!span) {
    const shadow = el.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = '#zt-name::before { content: attr(data-zt-name); }';
    span = document.createElement('span');
    span.id = 'zt-name';
    shadow.append(style, span);
    nameSpans.set(el, span);
  }
  span.setAttribute('data-zt-name', name);
}

function scan(root: ParentNode): void {
  root.querySelectorAll(MARKER_SELECTOR).forEach((el) => {
    knownMarkers.add(el);
    render(el);
  });
}

function renderAllKnown(): void {
  for (const el of knownMarkers) {
    render(el);
  }
}

function observeAdditions(): void {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) {
          return;
        }
        if (node.matches(MARKER_SELECTOR)) {
          knownMarkers.add(node);
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
    renderAllKnown();
    scan(document); // a marker that did not match before may match now
  });
}

void start();
