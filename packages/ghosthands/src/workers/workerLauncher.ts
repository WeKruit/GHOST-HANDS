#!/usr/bin/env bun
/**
 * Worker launcher — sets env vars BEFORE ESM imports hoist magnitude-core / BAML.
 */

// Let BAML log at info level so LLM reasoning is visible in terminal.
// magnitude-core tries to set BAML_LOG=off but that races with ESM import order.
// Setting it here (before dynamic import) ensures the Rust module reads it at init.
process.env.BAML_LOG = 'info';
process.env.RUST_LOG = 'error';
process.env.MAGNITUDE_LOG_LEVEL = 'warn';
delete process.env.MAGNITUDE_NARRATE;

// Now dynamically import main — env vars are set
export {};
await import('./main.js');
