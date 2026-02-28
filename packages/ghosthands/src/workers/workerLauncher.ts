#!/usr/bin/env bun
/**
 * Worker launcher — sets env vars BEFORE ESM imports hoist magnitude-core / BAML.
 *
 * ESM static imports execute before module body code, so `process.env.X ??= 'y'`
 * in main.ts runs AFTER magnitude-core's module init reads the env vars.
 * This dynamic import() launcher ensures env vars are set first.
 */
process.env.BAML_LOG ??= 'off';
process.env.MAGNITUDE_LOG_LEVEL ??= 'warn';

export {};
await import('./main.js');
