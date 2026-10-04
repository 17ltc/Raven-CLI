#!/usr/bin/env node
'use strict';
/**
 * Runs after `npm install`: puts `raven` on the PATH so you can simply type
 * `raven`. It never fails the install. Opt out with RAVEN_SKIP_SETUP=1, undo
 * with `raven uninstall`.
 */

const env = process.env;

function main() {
  if (env.RAVEN_SKIP_SETUP || env.CI) return;
  // `npm i -g` / dependency installs already get a `raven` bin from npm itself.
  if (env.npm_config_global === 'true') return;
  if (__dirname.split(require('path').sep).includes('node_modules')) return;

  const { install, resetProjectState } = require('../src/installer');
  resetProjectState();
  const r = install();
  if (r.changes.length) {
    console.log('\n  Raven: ' + r.changes.join('\n         '));
  }
  if (r.needsNewTerminal) {
    console.log('\n  Done. Open a NEW terminal, then just type:  raven');
    if (process.platform !== 'win32') console.log('  (or run `exec $SHELL -l` in this one)');
  } else {
    console.log('\n  Done. Just type:  raven');
  }
  console.log('  Undo any time with:  node bin/raven.js uninstall\n');
}

try {
  main();
} catch (e) {
  console.log(`\n  Raven: could not set up the PATH automatically (${e.message}).`);
  console.log('  Run it yourself later:  node bin/raven.js setup\n');
}
process.exit(0);
