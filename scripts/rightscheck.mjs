#!/usr/bin/env node
// Rights check: no official name of the game we are shaped after may sit in a tracked file.
// Two parts. (1) If overlay.local.json exists at the repo root (git-ignored, the owner's private
// map of our ids to official names), its values are a blocklist scanned over every tracked text file.
// (2) A fixed list of official script and publisher phrases, held only as SHA-256 hashes of the
// lower-cased phrase so this file never names them; tracked text is cut into one-, two- and
// three-word phrases (letters only, lower-cased) and any phrase whose hash is listed fails.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HASHES = new Set([
  '22e518d67b82c3692b62da21e913cc52d8c6e8d9051e3ca72842a86aab00712b',
  '480eb26362262c987f35b0548aa2d61424b59b04c864dad52f0bc9e54766d232',
  '9848c4be767c71b7ee1f443efd4682074114f030be25c3dfa9b6abb62b879103',
  '0a0bf2d7204185a2b5558d548314def0a1ea4c6c80727d9b23e31c804debe568',
  'e9559cd5be6a9129c39a62d4b903da11dcf057edeb98e0678c088dd59071a583',
  'f2879e7d135c316265f024639ef6566603de794bc9e589ce4a999d0313e01fd7',
]);

const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean);
const texts = [];
for (const f of files) {
  let buf;
  try { buf = readFileSync(resolve(root, f)); } catch { continue; }
  if (buf.includes(0)) continue; // binary
  texts.push([f, buf.toString('utf8')]);
}

const hits = [];
const sha = (s) => createHash('sha256').update(s).digest('hex');

// Part 1: the overlay.
const overlayPath = resolve(root, 'overlay.local.json');
if (existsSync(overlayPath)) {
  const names = [...new Set(Object.values(JSON.parse(readFileSync(overlayPath, 'utf8')))
    .map((v) => String(v).trim().toLowerCase()).filter(Boolean))];
  for (const [f, t] of texts) {
    t.split('\n').forEach((line, i) => {
      const low = line.toLowerCase();
      for (const n of names) if (low.includes(n)) hits.push(`${f}:${i + 1}: overlay name hit`);
    });
  }
  console.log(`overlay present, ${names.length} names checked`);
} else {
  console.log('no overlay, nothing to check');
}

// Part 2: the fixed hashed list.
for (const [f, t] of texts) {
  t.split('\n').forEach((line, i) => {
    const w = line.toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
    for (let n = 1; n <= 3; n++) {
      for (let k = 0; k + n <= w.length; k++) {
        if (HASHES.has(sha(w.slice(k, k + n).join(' ')))) hits.push(`${f}:${i + 1}: listed phrase`);
      }
    }
  });
}
// Phrases that wrap across lines are caught per file as well.
for (const [f, t] of texts) {
  const w = t.toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);
  for (let n = 2; n <= 3; n++) {
    for (let k = 0; k + n <= w.length; k++) {
      if (HASHES.has(sha(w.slice(k, k + n).join(' ')))) hits.push(`${f}: listed phrase across a line break`);
    }
  }
}

if (hits.length) {
  console.error('rightscheck FAILED:\n' + [...new Set(hits)].join('\n'));
  process.exit(1);
}
console.log('rightscheck: no hits');
