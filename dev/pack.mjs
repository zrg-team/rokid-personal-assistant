/**
 * Build dist/people-memory.aix
 *
 *   node dev/pack.mjs
 *
 * `.aix` ("AI eXecutable") is an extension of the Open Agent Format, and the
 * container is an ordinary ZIP — @yodaos-pkg/aix's reader is a zip reader, and
 * its wasm looks for `VERSION` and `app.json` by name. So the package is the
 * agent's own files plus a `VERSION` marker, zipped with paths relative to the
 * project root.
 *
 * Only the agent ships: dev/, node_modules/, .claude/ and the dist output stay
 * out, so nothing here can leak the harness or its dependencies onto a device.
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');

/** Everything the runtime loads, and nothing else. */
const CONTENTS = ['app.js', 'app.json', 'AGENTS.md', 'config.js', 'utils', 'pages'];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (e) {
    return false;
  }
}

async function main() {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  const appJson = JSON.parse(await readFile(join(ROOT, 'app.json'), 'utf8'));
  const name = pkg.name || 'agent';
  const version = pkg.version || '0.0.0';

  // app.json must list every page, or the framework will not register them.
  for (const page of appJson.pages || []) {
    if (!(await exists(join(ROOT, page + '.ink')))) {
      throw new Error('app.json lists "' + page + '" but ' + page + '.ink does not exist');
    }
  }

  // The agent-face CSS is copy-pasted into every page that draws one, and a
  // frame token with no matching rule renders as an invisible box rather than
  // anything that looks wrong. Neither failure surfaces on a device, so the
  // build refuses to produce an .aix that carries one.
  try {
    const { stdout } = await run(process.execPath, [join(ROOT, 'dev/check-face.mjs')]);
    process.stdout.write(stdout);
  } catch (error) {
    process.stderr.write(String(error.stderr || error.message));
    throw new Error('agent face check failed — see above');
  }

  // The dev camera only ever fires when the host has no real one, so shipping
  // it is harmless on glasses — but it is still a test fixture, and a build
  // that carries one should say so out loud.
  const config = await readFile(join(ROOT, 'config.js'), 'utf8');
  const devCamera = config.match(/devCameraUrl:\s*'([^']*)'/);
  if (devCamera && devCamera[1]) {
    console.log('\n  WARNING  FACE.devCameraUrl is set to ' + devCamera[1]);
    console.log('           Clear it in config.js for a device build.\n');
  }
  const devToken = config.match(/devToken:\s*'([^']*)'/);
  if (devToken && devToken[1]) {
    console.log('\n  WARNING  AUTH.devToken is set — a device token is baked in.');
    console.log('           Clear it in config.js for a device build.\n');
  }

  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  // getVersion() reads this file out of the archive.
  const versionFile = join(ROOT, 'VERSION');
  await writeFile(versionFile, version + '\n');

  const out = join(DIST, name + '-' + version + '.aix');
  const entries = CONTENTS.filter(Boolean).concat(['VERSION']);
  const present = [];
  for (const entry of entries) {
    if (await exists(join(ROOT, entry))) present.push(entry);
  }

  // -r recurse, -X drop extra attributes, -9 max deflate.
  // `pages/` is shipped wholesale, so a developer-only page inside it would ride
  // along and — worse — be visible to the host model as something dispatchable.
  // pages/probe is the agent-face vocabulary probe; it exists to be opened by
  // hand in dev/runtime.html and must never reach a device.
  const EXCLUDE = ['pages/probe/*'];

  await run('zip', ['-r', '-X', '-9', '-q', out, ...present, '-x', ...EXCLUDE], { cwd: ROOT });
  await rm(versionFile, { force: true });

  const { stdout } = await run('unzip', ['-l', out]);
  const files = stdout.trim().split('\n').length - 5;
  const size = (await stat(out)).size;

  console.log('');
  console.log('  ' + out.replace(ROOT + '/', ''));
  console.log('  ' + files + ' files, ' + (size / 1024).toFixed(1) + ' KB');
  console.log('  pages: ' + (appJson.pages || []).join(', '));
  console.log('');
  console.log('  Verify:  http://localhost:5178/dev/aix-check.html');
  console.log('');
}

main().catch((error) => {
  console.error('pack failed:', error.message);
  process.exit(1);
});
