#!/usr/bin/env bun
/**
 * Worker launcher — spawns main.ts as a child process and filters its output.
 *
 * BAML's Rust module writes directly to fd 1/2, bypassing all JS-level
 * stdout overrides. The ONLY reliable way to filter it is to pipe the
 * child's stdout/stderr and filter line-by-line before writing to our own stdout.
 *
 * Filter rules:
 *   - Lines from `---PROMPT---` through just before `---LLM REPLY---` → hidden
 *   - `[BAML INFO]` header line → shown (has function name, timing, tokens)
 *   - `---LLM REPLY---` and everything after → shown
 *   - `◆ [act]` narrator lines → hidden
 */

import { spawn } from 'node:child_process';
import path from 'node:path';

// Set env vars before spawning (belt-and-suspenders)
process.env.BAML_LOG = 'off';
process.env.RUST_LOG = 'error';
process.env.MAGNITUDE_LOG_LEVEL = 'warn';
delete process.env.MAGNITUDE_NARRATE;

const mainPath = path.join(import.meta.dir, 'main.ts');
const args = process.argv.slice(2);

const child = spawn('bun', [mainPath, ...args], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: process.env,
  cwd: process.cwd(),
});

let suppressingPrompt = false;

function processLine(line: string): void {
  // Hide narrator lines
  if (line.includes('\u25C6 [act]')) return;

  // When we see ---PROMPT---, start suppressing
  if (line.includes('---PROMPT---')) {
    suppressingPrompt = true;
    return;
  }

  // When we see ---LLM REPLY---, stop suppressing and show it
  if (line.includes('---LLM REPLY---')) {
    suppressingPrompt = false;
    process.stdout.write(line + '\n');
    return;
  }

  // While suppressing, hide everything (prompt content)
  if (suppressingPrompt) return;

  // Everything else passes through
  process.stdout.write(line + '\n');
}

function processChunk(chunk: Buffer, buf: { data: string }): void {
  buf.data += chunk.toString('utf8');
  const lines = buf.data.split('\n');
  buf.data = lines.pop() || ''; // keep incomplete last line in buffer
  for (const line of lines) {
    processLine(line);
  }
}

const stdoutBuf = { data: '' };
const stderrBuf = { data: '' };

child.stdout?.on('data', (chunk: Buffer) => processChunk(chunk, stdoutBuf));
child.stderr?.on('data', (chunk: Buffer) => processChunk(chunk, stderrBuf));

child.on('exit', (code, signal) => {
  // Flush remaining buffer
  if (stdoutBuf.data) processLine(stdoutBuf.data);
  if (stderrBuf.data) processLine(stderrBuf.data);
  process.exit(code ?? (signal ? 1 : 0));
});

// Forward signals to child
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
