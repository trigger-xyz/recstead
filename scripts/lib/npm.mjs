import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

/**
 * Invoke npm through its JavaScript entry point, including on Windows.
 * @param {string[]} args
 * @param {import('node:child_process').ExecFileSyncOptions} [options]
 * @returns {string}
 */
export function runNpm(args, options = {}) {
  const cli = process.env.npm_execpath;
  assert(cli, 'Run this command through its npm script so npm_execpath is available.');
  return String(execFileSync(process.execPath, [cli, ...args], { ...options, encoding: 'utf8' }) ?? '');
}
