// Raises the patch part of the version in manifest.json and package.json by
// one, writes both files, and prints the new version. The release workflow
// runs it after CI passes on main. Only the top-level "version" line changes,
// so the rest of each file keeps its layout.
import { readFileSync, writeFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const parts = manifest.version.split('.').map(Number);
if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
  console.error(`manifest.json version "${manifest.version}" is not MAJOR.MINOR.PATCH.`);
  process.exit(1);
}
const next = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;

for (const file of ['manifest.json', 'package.json']) {
  const text = readFileSync(file, 'utf8');
  const current = JSON.parse(text).version;
  const line = `"version": "${current}"`;
  if (text.split(line).length !== 2) {
    console.error(`${file} does not hold exactly one ${line} line.`);
    process.exit(1);
  }
  const updated = text.replace(line, `"version": "${next}"`);
  if (JSON.parse(updated).version !== next) {
    console.error(`${file}: the version did not change to ${next}.`);
    process.exit(1);
  }
  writeFileSync(file, updated);
}

process.stdout.write(next);
