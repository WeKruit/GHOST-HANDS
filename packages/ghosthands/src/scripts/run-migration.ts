#!/usr/bin/env bun
/**
 * Run database migrations for GhostHands
 *
 * Usage:
 *   bun src/scripts/run-migration.ts                     # Run all migrations in order
 *   bun src/scripts/run-migration.ts 007                 # Run specific migration by number
 *   bun src/scripts/run-migration.ts 007_add_target_worker_id.sql  # Run by filename
 */

import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import pg from 'pg';

const { Pool } = pg;

// Load .env from package root (packages/ghosthands/.env)
const envPath = join(__dirname, '../../.env');
try {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }
} catch {
  // .env may not exist if env vars are set directly
}

const MIGRATIONS_DIR = join(__dirname, '../db/migrations');

function getMigrationFiles(filter?: string): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (!filter) return files;

  // Match by number prefix (e.g., "007") or full filename
  return files.filter(
    (f) => f.startsWith(filter) || f === filter
  );
}

async function runMigration() {
  const filter = process.argv[2];
  const files = getMigrationFiles(filter);

  if (files.length === 0) {
    console.error(`No migration files found${filter ? ` matching "${filter}"` : ''}`);
    console.error(`Available migrations:`);
    readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .forEach((f) => console.error(`  ${f}`));
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_DIRECT_URL || process.env.SUPABASE_DIRECT_URL || process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('Missing database connection string (DATABASE_DIRECT_URL, SUPABASE_DIRECT_URL, or DATABASE_URL)');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: dbUrl });

  try {
    const dbHost = dbUrl.split('@')[1]?.split('?')[0] || 'unknown';
    console.log(`Database: ${dbHost}`);
    console.log(`Migrations to run: ${files.length}\n`);

    for (const file of files) {
      const filePath = join(MIGRATIONS_DIR, file);
      const sql = readFileSync(filePath, 'utf8');

      console.log(`Running ${file}...`);
      await pool.query(sql);
      console.log(`  Done.\n`);
    }

    console.log(`All ${files.length} migration(s) completed successfully.`);
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

runMigration().catch((error) => {
  console.error(error);
  process.exit(1);
});
