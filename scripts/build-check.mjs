// Builds the extension twice, in two clean directories, and fails if the
// two zips do not hash the same (issue #3786: "The CI job builds the zip
// twice in clean directories and fails if the two SHA-256 hashes differ.").
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDateEpoch = process.env['SOURCE_DATE_EPOCH'] ?? '1735689600'; // 2025-01-01T00:00:00Z: any fixed value proves determinism

function buildOnce(outDirName) {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, OUT_DIR: outDirName, SOURCE_DATE_EPOCH: sourceDateEpoch },
  });
  return readFileSync(join(ROOT, `${outDirName}.zip`));
}

function main() {
  const first = buildOnce('dist-check-a');
  const second = buildOnce('dist-check-b');
  const matches = Buffer.compare(first, second) === 0;

  rmSync(join(ROOT, 'dist-check-a'), { recursive: true, force: true });
  rmSync(join(ROOT, 'dist-check-b'), { recursive: true, force: true });
  rmSync(join(ROOT, 'dist-check-a.zip'), { force: true });
  rmSync(join(ROOT, 'dist-check-b.zip'), { force: true });
  rmSync(join(ROOT, 'dist-check-a.zip.sha256'), { force: true });
  rmSync(join(ROOT, 'dist-check-b.zip.sha256'), { force: true });

  if (!matches) {
    console.error('Two clean builds of the same source produced different zips. The build is not deterministic.');
    process.exit(1);
  }
  console.log('Two clean builds produced the same zip.');
}

main();
