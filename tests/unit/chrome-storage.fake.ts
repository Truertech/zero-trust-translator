/**
 * A minimal in-memory stand-in for `chrome.storage.local`, for the unit tests only.
 * `get` and `set` copy the value, as the real API does (it serialises every
 * value): a fake that hands back the stored object itself lets two writers
 * share one object, which hides a lost write.
 */
export interface FakeChromeStorage {
  /** Writes a raw value straight into the backing store, as another writer or an older version would. */
  seed(key: string, value: unknown): void;
  /** Makes the next `set` call reject with `error`, once. */
  failNextSet(error: Error): void;
}

export function installFakeChromeStorage(): FakeChromeStorage {
  let backing: Record<string, unknown> = {};
  let nextSetError: Error | null = null;
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => structuredClone({ [key]: backing[key] }),
        set: async (items: Record<string, unknown>) => {
          if (nextSetError) {
            const error = nextSetError;
            nextSetError = null;
            throw error;
          }
          backing = { ...backing, ...structuredClone(items) };
        },
      },
      onChanged: {
        addListener: () => {
          /* not exercised by the unit tests; content.ts is covered by the extension's own Playwright tests */
        },
      },
    },
  };
  return {
    seed: (key, value) => {
      backing = { ...backing, [key]: structuredClone(value) };
    },
    failNextSet: (error) => {
      nextSetError = error;
    },
  };
}
