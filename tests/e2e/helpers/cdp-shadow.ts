// Reads the rendered name back out of a CLOSED shadow root for the test's
// own assertions. `content.ts` deliberately makes this unreachable from the
// page's own JavaScript (`element.shadowRoot` reads `null` there); Chrome
// DevTools Protocol is a different, privileged channel that always sees
// into a shadow root regardless of its mode (the same reason the DevTools
// Elements panel can always show "shadow-root (closed)" nodes). Using CDP
// here, rather than loosening the page's own read, is what lets this test
// prove the name renders AND prove the page cannot read it, in the same run.
import type { CDPSession, Page } from '@playwright/test';

interface CdpNode {
  nodeId: number;
  nodeName: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
}

function attribute(node: CdpNode, name: string): string | undefined {
  const attrs = node.attributes ?? [];
  const index = attrs.indexOf(name);
  return index >= 0 ? attrs[index + 1] : undefined;
}

function* walk(node: CdpNode): Generator<CdpNode> {
  yield node;
  for (const child of node.children ?? []) {
    yield* walk(child);
  }
}

function findHost(node: CdpNode, needle: string): CdpNode | undefined {
  if ((attribute(node, 'data-zt-id') ?? '').toLowerCase() === needle) {
    return node;
  }
  for (const child of node.children ?? []) {
    const found = findHost(child, needle);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function findNameSpan(node: CdpNode): CdpNode | undefined {
  for (const n of walk(node)) {
    if (n.nodeName === 'SPAN' && attribute(n, 'id') === 'zt-name') {
      return n;
    }
  }
  return undefined;
}

/**
 * Finds the light-DOM element with `data-zt-id="<id>"` (case-insensitive,
 * the same as the content script) and reads the `data-zt-name` attribute
 * off the `#zt-name` span inside its closed shadow root. Returns
 * `undefined` when no shadow root has been attached (the marker is not in
 * the list, or the content script has not run yet).
 */
export async function readRenderedName(page: Page, markerId: string): Promise<string | undefined> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const host = findHost(root as CdpNode, markerId.toLowerCase());
  if (!host || !host.shadowRoots || host.shadowRoots.length === 0) {
    return undefined;
  }
  const span = findNameSpan(host.shadowRoots[0]!);
  return span ? attribute(span, 'data-zt-name') : undefined;
}

/** Reads the page badge (`data-testid="zt-badge"`): its state class and its text, from inside its closed shadow root. */
export async function readBadge(page: Page): Promise<{ state: string; text: string } | undefined> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  let host: CdpNode | undefined;
  for (const n of walk(root as CdpNode)) {
    if (attribute(n, 'data-testid') === 'zt-badge') {
      host = n;
    }
  }
  if (!host?.shadowRoots?.[0]) {
    return undefined;
  }
  let state = '';
  let text = '';
  for (const n of walk(host.shadowRoots[0])) {
    if (attribute(n, 'id') === 'b') {
      state = attribute(n, 'class') ?? '';
    }
    if (attribute(n, 'id') === 't') {
      text = attribute(n, 'data-zt-text') ?? '';
    }
  }
  return { state, text };
}