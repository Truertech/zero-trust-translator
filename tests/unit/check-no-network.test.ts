import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'check-no-network.mjs');
let dir: string;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('check-no-network.mjs', () => {
  it('fails on a bundle that contains fetch(', () => {
    dir = mkdtempSync(join(tmpdir(), 'zt-no-network-'));
    writeFileSync(join(dir, 'content.js'), 'void fetch("https://example.com");');

    expect(() => execFileSync(process.execPath, [SCRIPT, dir], { stdio: 'pipe' })).toThrow();
  });

  it('passes on a bundle with no network API and no remote URL', () => {
    dir = mkdtempSync(join(tmpdir(), 'zt-no-network-'));
    writeFileSync(join(dir, 'content.js'), 'console.log("hello");');

    expect(() => execFileSync(process.execPath, [SCRIPT, dir], { stdio: 'pipe' })).not.toThrow();
  });
});
