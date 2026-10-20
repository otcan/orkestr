#!/usr/bin/env node
// Deploy preflight: check that this release accepts every live scoped WhatsApp
// group configuration before any connector service is stopped. Pure validation:
// no journal, route fence or proof database is opened. Prints codes only.
import fs from 'node:fs';
import { validateScopedGroupConfig } from '../packages/connectors/src/whatsapp-scoped-group-transport.js';
import { isMainModule } from './main-module.mjs';

export function preflightScopedGroupConfigs(paths, { readFile = file => fs.readFileSync(file, 'utf8') } = {}) {
  const results = [...new Set(paths.filter(Boolean))].map(file => {
    try {
      validateScopedGroupConfig(JSON.parse(readFile(file)));
      return { file, ok: true };
    } catch (error) {
      const code = String(error?.message || 'unknown');
      return { file, ok: false, code: /^[a-z0-9_]{1,120}$/.test(code) ? code : 'configuration_unreadable' };
    }
  });
  return { ok: results.every(result => result.ok), results };
}

if (isMainModule(import.meta.url)) {
  const result = preflightScopedGroupConfigs(process.argv.slice(2));
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
