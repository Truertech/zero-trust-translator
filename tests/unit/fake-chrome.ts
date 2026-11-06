/**
 * An in-memory stand-in for the part of the `chrome` API that the service
 * worker (`src/background.ts`) uses, for the unit tests only. It records
 * every call the tests assert on: the session access level, the idle
 * detection interval, the refresh messages sent to tabs and the tabs opened.
 *
 * `get` and `set` copy every value, as the real API does (it serialises
 * every value), so a test never shares an object with the worker.
 */
import type { ChromeApi, MessageSender } from '../../src/background';

export const EXTENSION_ID = 'ztfakeextensionid';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;

/** A sender that is an extension page (the popup). */
export const PAGE_SENDER: MessageSender = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}popup.html` };

/** A sender that is the content script in a branch platform tab. */
export const CONTENT_SENDER: MessageSender = { id: EXTENSION_ID, url: 'https://app.example.org/members', tab: { id: 1 } };

/** The tab whose `sendMessage` rejects, as Chrome does for a tab with no content script. */
export const TAB_WITHOUT_CONTENT_SCRIPT = 2;

export class FakeStorageArea {
  data: Record<string, unknown> = {};

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    if (keys === null) {
      return structuredClone(this.data);
    }
    const out: Record<string, unknown> = {};
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (key in this.data) {
        out[key] = structuredClone(this.data[key]);
      }
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.data = { ...this.data, ...structuredClone(items) };
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      delete this.data[key];
    }
  }

  async clear(): Promise<void> {
    this.data = {};
  }
}

export class FakeSessionArea extends FakeStorageArea {
  accessLevels: string[] = [];

  async setAccessLevel(options: { accessLevel: string }): Promise<void> {
    this.accessLevels.push(options.accessLevel);
  }
}

type MessageListener = (message: unknown, sender: MessageSender, sendResponse: (r: unknown) => void) => boolean | void;

export interface FakePort {
  name: string;
  onMessage: { addListener(fn: (message: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
  /** Sends a message from the page to the worker. */
  post(message: unknown): void;
  /** Closes the port from the page side. */
  disconnect(): void;
}

export function makePort(name: string): FakePort {
  const messageListeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  return {
    name,
    onMessage: { addListener: (fn) => void messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => void disconnectListeners.push(fn) },
    post: (message) => messageListeners.forEach((fn) => fn(message)),
    disconnect: () => disconnectListeners.forEach((fn) => fn()),
  };
}

export class FakeChrome {
  readonly local = new FakeStorageArea();
  readonly session = new FakeSessionArea();
  readonly idleIntervals: number[] = [];
  /** Every `tabs.sendMessage` call, including the one that rejects. */
  readonly sent: { tabId: number; message: unknown }[] = [];
  readonly created: string[] = [];
  /** Tab 3 has no id, as a devtools window can have. */
  tabs: { id?: number }[] = [{ id: 1 }, { id: TAB_WITHOUT_CONTENT_SCRIPT }, {}];
  messageListeners: MessageListener[] = [];
  connectListeners: ((port: FakePort) => void)[] = [];
  idleListeners: ((state: string) => void)[] = [];

  readonly api: ChromeApi = {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `${EXTENSION_ORIGIN}${path}`,
      getManifest: () => ({ version: '1.0.0' }),
      onMessage: { addListener: (fn) => void this.messageListeners.push(fn) },
      onConnect: { addListener: (fn) => void this.connectListeners.push(fn as (port: FakePort) => void) },
    },
    storage: { local: this.local, session: this.session },
    idle: {
      setDetectionInterval: (seconds: number) => void this.idleIntervals.push(seconds),
      onStateChanged: { addListener: (fn) => void this.idleListeners.push(fn) },
    },
    tabs: {
      query: async () => structuredClone(this.tabs),
      sendMessage: async (tabId: number, message: unknown) => {
        this.sent.push({ tabId, message });
        if (tabId === TAB_WITHOUT_CONTENT_SCRIPT) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        return undefined;
      },
      create: async (properties: { url: string }) => {
        this.created.push(properties.url);
        return {};
      },
    },
  };

  /** A copy of both storage areas, to start another fake from the same state. */
  snapshot(): StorageSnapshot {
    return { local: structuredClone(this.local.data), session: structuredClone(this.session.data) };
  }

  static from(snapshot: StorageSnapshot): FakeChrome {
    const chrome = new FakeChrome();
    chrome.local.data = structuredClone(snapshot.local);
    chrome.session.data = structuredClone(snapshot.session);
    return chrome;
  }
}

export interface StorageSnapshot {
  local: Record<string, unknown>;
  session: Record<string, unknown>;
}
