import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it.each([
    ['XMLHttpRequest', 'new XMLHttpRequest();'],
    ['WebSocket', 'new WebSocket("ws://x");'],
    ['EventSource', 'new EventSource("/x");'],
    ['sendBeacon', 'navigator.sendBeacon("/x");'],
    ['importScripts', 'importScripts("/x.js");'],
    ['a remote https URL', 'const u = "https://example.com/x";'],
    ['a remote http URL', 'const u = "http://example.com/x";'],
  ])('fails on a bundle that contains %s', (_label, source) => {
    dir = mkdtempSync(join(tmpdir(), 'zt-no-network-'));
    writeFileSync(join(dir, 'popup.js'), source);

    expect(() => execFileSync(process.execPath, [SCRIPT, dir], { stdio: 'pipe' })).toThrow();
  });

  it('passes on a localhost or 127.0.0.1 URL, which the dev build matches', () => {
    dir = mkdtempSync(join(tmpdir(), 'zt-no-network-'));
    writeFileSync(join(dir, 'content.js'), 'const a = "http://localhost/*"; const b = "http://127.0.0.1:4321/page.html";');

    expect(() => execFileSync(process.execPath, [SCRIPT, dir], { stdio: 'pipe' })).not.toThrow();
  });

  it('scans .js and .mjs files in sub-folders', () => {
    dir = mkdtempSync(join(tmpdir(), 'zt-no-network-'));
    mkdirSync(join(dir, 'nested'));
    writeFileSync(join(dir, 'nested', 'chunk.mjs'), 'void fetch("/x");');

    expect(() => execFileSync(process.execPath, [SCRIPT, dir], { stdio: 'pipe' })).toThrow();
  });

  it('passes on a page whose only remote address is the href of a link', () => {
    dir = mkdtempSync(join(tmpdir(), 'zt-no-network-'));
    writeFileSync(join(dir, 'popup.html'), '<a data-link="source" href="https://github.com/Truertech/zero-trust-translator">source</a><script src="popup.js"></script>');

    expect(() => execFileSync(process.execPath, [SCRIPT, dir], { stdio: 'pipe' })).not.toThrow();
  });

  it.each([
    ['popup.html', 'a remote image', '<img src="https://example.com/a.png">'],
    ['options.html', 'a remote stylesheet', '<link rel="stylesheet" href="https://fonts.example.com/x.css">'],
    ['unlock.html', 'a remote script', '<script src="https://example.com/x.js"></script>'],
    ['popup.css', 'a remote font', '@font-face { src: url(https://fonts.example.com/f.woff2); }'],
    ['options.css', 'a remote background image', '.x { background: url("http://example.com/a.png"); }'],
  ])('fails on %s with %s', (name, _label, source) => {
    dir = mkdtempSync(join(tmpdir(), 'zt-no-network-'));
    writeFileSync(join(dir, name), source);

    expect(() => execFileSync(process.execPath, [SCRIPT, dir], { stdio: 'pipe' })).toThrow();
  });

  it('does not refuse the word fetch( in a page text, only in a script', () => {
    dir = mkdtempSync(join(tmpdir(), 'zt-no-network-'));
    writeFileSync(join(dir, 'popup.html'), '<p>Nothing here calls fetch() or XMLHttpRequest.</p>');

    expect(() => execFileSync(process.execPath, [SCRIPT, dir], { stdio: 'pipe' })).not.toThrow();
  });
});
