#!/usr/bin/env bun
/**
 * Run database migration for GhostHands
 * Uses the DATABASE_DIRECT_URL from .env
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import pg from 'pg';

const { Pool } = pg;

// Load .env from package root (packages/ghosthands/.env)
const envPath = join(__dirname, '../../.env');
const envContent = readFileSync(envPath, 'utf8');
for (const line of envContent.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) {
    const key = match[1].trim();
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    process.env[key] = value;
  }
}

async function runMigration() {
  const migrationPath = join(__dirname, '../db/migrations/001_gh_user_usage.sql');
  const sql = readFileSync(migrationPath, 'utf8');

  const pool = new Pool({
    connectionString: process.env.DATABASE_DIRECT_URL,
  });

  try {
    console.log('🔄 Running GhostHands database migration...\n');
    console.log('Migration file:', migrationPath);
    console.log('Database:', process.env.DATABASE_DIRECT_URL?.split('@')[1]?.split('?')[0], '\n');

    await pool.query(sql);

    console.log('✅ Migration completed successfully!\n');
    console.log('Created:');
    console.log('  - Table: gh_user_usage');
    console.log('  - Indexes: idx_gh_user_usage_user_period, idx_gh_user_usage_period, idx_gh_user_usage_tier');
    console.log('  - RLS Policies: Service role full access, Users can read own usage');
    console.log('  - Trigger: Auto-update updated_at timestamp\n');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

runMigration().catch((error) => {
  console.error(error);
  process.exit(1);
});
