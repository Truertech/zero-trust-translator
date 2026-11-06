/** A minimal in-memory stand-in for `chrome.storage.local`, for the unit tests only. */
export function installFakeChromeStorage(): void {
  let backing: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => ({ [key]: backing[key] }),
        set: async (items: Record<string, unknown>) => {
          backing = { ...backing, ...items };
        },
      },
      onChanged: {
        addListener: () => {
          /* not exercised by the unit tests; content.ts is covered by the extension's own Playwright tests */
        },
      },
    },
  };
}
