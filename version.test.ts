import { expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ALIASMODE_VERSION } from './version.ts';
import { RUNTIME_VERSION } from './agent/runtime-client.mjs';
const root=import.meta.dir;
const read=(file:string)=>readFileSync(join(root,file),'utf8');

test('local desktop and helper keep a compatible version',()=>{
  expect(RUNTIME_VERSION).toBe(ALIASMODE_VERSION);
  expect(JSON.parse(read('package.json')).version).toBe(ALIASMODE_VERSION);
  expect(JSON.parse(read('src-tauri/tauri.conf.json')).version).toBe(ALIASMODE_VERSION);
  expect(read('src-tauri/Cargo.toml').match(/^version = "([^"]+)"$/m)?.[1]).toBe(ALIASMODE_VERSION);
  expect(read('src-tauri/Cargo.lock').match(/name = "aliasmode-desktop"\r?\nversion = "([^"]+)"/)?.[1]).toBe(ALIASMODE_VERSION);
});

test('local desktop keeps a separate identity and only exposes build-pinned signed updates',()=>{
  const config=JSON.parse(read('src-tauri/tauri.conf.json'));
  expect(config.identifier).toBe('com.maobu.local');
  expect(config.bundle.createUpdaterArtifacts).toBe(false);
  expect(config.plugins?.updater).toBeUndefined();
  expect(read('src-tauri/Cargo.toml')).toContain('tauri-plugin-updater');
  const native=read('src-tauri/src/lib.rs');
  expect(native).not.toContain('releases::');
  expect(native).not.toContain('credential_get,');
  expect(native).not.toContain('allow-update-bridge');
  expect(existsSync(join(root,'src-tauri/src/releases.rs'))).toBe(false);
  const updates=read('src-tauri/src/signed_updates.rs');
  expect(updates).toContain('option_env!("MAOBU_UPDATE_PUBLIC_KEY")');
  expect(updates).toContain('option_env!("MAOBU_UPDATE_ENDPOINT")');
  expect(updates).toContain('update.download(');
  expect(updates).toContain('update.install(bytes)');
  expect(updates).not.toContain('Command::new');
  expect(read('src-tauri/permissions/signed-updates.toml')).toContain('signed_update_install');
});

test('local launcher builds from the workspace instead of installing the upstream distribution',()=>{
  const launcher=read('scripts/run-local-desktop.mjs');
  expect(launcher).toContain('src-tauri');
  expect(launcher).toContain('MaobuBrowser-local-');
  expect(launcher).not.toMatch(/https?:\/\//);
  expect(JSON.parse(read('agent-install.json')).localOnly).toBe(true);
});
