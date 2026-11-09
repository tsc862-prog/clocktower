// The lore check: every seat and the Storyteller has a distinct voice in range and a portrait brief,
// and the voice ids and seat names agree with docs/ROLES.md.
import {readFileSync} from 'node:fs';
import {VOICES, DEFAULT_VOICE, voiceFor} from '../src/data/voices.js';
import {PORTRAITS, PORTRAIT_STYLE} from '../src/data/portraits.js';

const NAMES = ['Odette', 'Bram', 'Ines', 'Corwin', 'Thea', 'Fitch', 'Yusuf', 'Storyteller'];
const roles = readFileSync(new URL('../docs/ROLES.md', import.meta.url), 'utf8');
const problems = [];
const seen = new Map();

for (const name of NAMES) {
  const v = VOICES[name];
  if (!v) { problems.push(`${name}: no voice`); continue; }
  if (!/^[ab][fm]_[a-z0-9_]+$/.test(v.voice)) problems.push(`${name}: odd voice id ${v.voice}`);
  if (!(v.speed >= 0.9 && v.speed <= 1.1)) problems.push(`${name}: speed ${v.speed} outside 0.9-1.1`);
  if (seen.has(v.voice)) problems.push(`${name}: voice ${v.voice} also used by ${seen.get(v.voice)}`);
  seen.set(v.voice, name);
  if (!roles.includes('`' + v.voice + '`')) problems.push(`${name}: voice ${v.voice} not in docs/ROLES.md`);
  if (!roles.includes(name)) problems.push(`${name}: not in docs/ROLES.md`);
  const p = PORTRAITS[name];
  if (!p || typeof p.prompt !== 'string' || p.prompt.length < 80) problems.push(`${name}: no portrait brief`);
  else if (/blood on the clocktower|pandemonium|official art/i.test(p.prompt)) problems.push(`${name}: portrait names the official game`);
}
for (const name of Object.keys(VOICES)) if (!NAMES.includes(name)) problems.push(`${name}: voice for an unknown seat`);
for (const name of Object.keys(PORTRAITS)) if (!NAMES.includes(name)) problems.push(`${name}: portrait for an unknown seat`);
if (!DEFAULT_VOICE?.voice) problems.push('no DEFAULT_VOICE');
if (voiceFor('Nobody') !== DEFAULT_VOICE) problems.push('voiceFor an unknown name is not the default');
if (!PORTRAIT_STYLE || !roles.includes(PORTRAIT_STYLE)) problems.push('PORTRAIT_STYLE missing or not in docs/ROLES.md');

if (problems.length) {
  console.error('lorecheck failed:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log(`lorecheck ok: ${NAMES.length} voices (distinct), ${NAMES.length} portrait briefs`);
