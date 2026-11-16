#!/usr/bin/env node
/**
 * Sets the two GitHub Actions secrets the hourly "Wake and tick" workflow needs, from the values
 * stored by the other scripts. Values are passed to `gh` on stdin, never as arguments.
 *   node scripts/deploy/github-secrets.mjs [--dry-run]
 */
import { spawnSync } from 'node:child_process';
import { fail, loadSecrets, ok, require, step } from './lib.mjs';

const dryRun = process.argv.includes('--dry-run');
const secrets = loadSecrets();
try {
  require(secrets, 'APP_URL', 'TICK_TOKEN');
} catch (error) {
  fail(error.message);
  process.exit(1);
}

step('GitHub Actions secrets (repository Ayush-o1/Cadentra)');
for (const name of ['APP_URL', 'TICK_TOKEN']) {
  if (dryRun) {
    ok(`would set ${name}`);
    continue;
  }
  const result = spawnSync('gh', ['secret', 'set', name, '--repo', 'Ayush-o1/Cadentra'], {
    input: secrets[name],
    encoding: 'utf8',
  });
  if (result.status === 0) ok(`set ${name}`);
  else fail(`could not set ${name}: ${result.stderr.trim().split('\n').pop()}`);
}
