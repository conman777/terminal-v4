const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('rebuild uses the configured project, builds the Rust runtime and leaves service restart to the owner', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'terminal-rebuild-'));
  try {
    const project = path.join(root, 'project with spaces');
    const bin = path.join(root, 'bin');
    mkdirSync(project); mkdirSync(bin);
    const log = path.join(root, 'commands');
    for (const command of ['npm', 'cargo', 'sudo']) {
      writeFileSync(path.join(bin, command), '#!/bin/sh\nprintf "%s|%s|%s\\n" "$(basename "$0")" "$*" "$PWD" >> "$REBUILD_TEST_LOG"\n', { mode: 0o700 });
    }
    const result = spawnSync('bash', [path.join(__dirname, '..', 'rebuild.sh')], {
      cwd: root, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, REBUILD_PROJECT_ROOT: project, REBUILD_TEST_LOG: log }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
      `npm|run frontend:build|${project}`,
      `cargo|build --release -p terminal-v4-api --manifest-path rust/Cargo.toml|${project}`
    ]);
    assert.match(result.stdout, /restart/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
