#!/usr/bin/env node
/**
 * Keep the agent-face CSS identical across every page that draws one.
 *
 * ## Why this exists
 *
 * Ink pages have no shared stylesheet. `@import` is listed as supported but has
 * never been exercised inside an `.ink` `<style>` block here, and a silent
 * failure there would blank the face on every page at once — so the rules are
 * copy-pasted, the same way `.card` already is.
 *
 * Copy-paste is fine right up until one page drifts. The face is worse than most
 * duplication for this, because the drift is invisible: a stale `.eb` on one page
 * does not throw, it just makes that page's "listening" look slightly wrong, and
 * nobody notices until they happen to compare two cards side by side.
 *
 * So the block is delimited, one copy is canonical, and this fails the build if
 * any other page disagrees with it.
 *
 *   node dev/check-face.mjs          verify (exit 1 on drift)
 *   node dev/check-face.mjs --sync   rewrite the others from the canonical copy
 *
 * The mood definitions that choose between these classes live in utils/mood.js;
 * only the shapes live here.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

import { faceTokens } from '../utils/mood.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The copy every other page is measured against. */
const CANONICAL = 'pages/signin/signin.ink';

/** Pages that draw a face. `schedule` is a one-shot card and deliberately has none. */
const PAGES = [
  'pages/signin/signin.ink',
  'pages/index/index.ink',
  'pages/connection/connection.ink',
  'pages/face/face.ink',
];

/**
 * The delimited block, markers included.
 *
 * The tail is `[^*]*?` rather than a literal run of `=`, so the rule bar after
 * `agentface:end` can be any length without this silently failing to find a
 * block that is plainly there.
 */
const BLOCK = /\/\* ==== agentface:begin[\s\S]*?agentface:end[^*]*?\*\//;

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function blockOf(source, rel) {
  const found = source.match(BLOCK);
  if (!found) {
    throw new Error(
      rel + ' has no agentface block. Every page listed in dev/check-face.mjs ' +
      'must carry one between the begin/end markers.'
    );
  }
  return found[0];
}

const sync = process.argv.includes('--sync');

let canonical;
try {
  canonical = blockOf(read(CANONICAL), CANONICAL);
} catch (error) {
  console.error('agent face: ' + error.message);
  process.exit(1);
}

const drifted = [];

for (const rel of PAGES) {
  if (rel === CANONICAL) continue;

  const source = read(rel);
  let mine;
  try {
    mine = blockOf(source, rel);
  } catch (error) {
    console.error('agent face: ' + error.message);
    process.exit(1);
  }

  if (mine === canonical) continue;

  if (sync) {
    writeFileSync(join(ROOT, rel), source.replace(BLOCK, canonical));
    console.log('agent face: synced ' + rel);
  } else {
    drifted.push(rel);
  }
}

/*
 * The other half of the job: every class the frame table can emit must exist in
 * the CSS. This is the check that catches a typo before a wearer does — an
 * unstyled dot is invisible rather than wrong-looking, so nothing downstream
 * would ever complain about it.
 */
// Comments first: the markers mention `dev/check-face.mjs`, and a naive scan
// happily reads that filename's extension as a class named `mjs`.
const rules = canonical.replace(/\/\*[\s\S]*?\*\//g, '');

const declared = new Set();
for (const rule of rules.matchAll(/\.([A-Za-z][\w-]*)/g)) declared.add(rule[1]);

const missing = faceTokens().filter((token) => !declared.has(token));
if (missing.length) {
  console.error(
    'agent face: utils/mood.js emits class tokens the CSS never defines:\n' +
    missing.map((t) => '  .' + t + '  — would render as an invisible zero-size box').join('\n')
  );
  process.exit(1);
}

// The reverse is only worth a nudge: a spare rule costs bytes, not correctness.
// `face`/`eyes`/`mouth` are the structural containers, not tokens.
const LAYOUT = new Set(['face', 'eyes', 'mouth']);
const used = new Set(faceTokens());
const spare = [...declared].filter((c) => !used.has(c) && !LAYOUT.has(c)).sort();
if (spare.length) {
  console.warn('agent face: CSS defines unused tokens: ' + spare.map((c) => '.' + c).join(', '));
}

if (drifted.length) {
  console.error(
    'agent face: these pages have drifted from ' + relative('.', CANONICAL) + ':\n' +
    drifted.map((p) => '  - ' + p).join('\n') +
    '\n\nRun `node dev/check-face.mjs --sync` to bring them back in line.'
  );
  process.exit(1);
}

console.log('agent face: ' + PAGES.length + ' pages in sync.');
