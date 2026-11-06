// Builds the dev extension once before the Playwright run, into `dist-dev`
// (never `dist`/`dist.zip`, which are the release artifacts).
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export default function globalSetup(): void {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs'), '--dev'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, OUT_DIR: 'dist-dev' },
  });
}
