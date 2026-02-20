#!/usr/bin/env bun
/**
 * Verify GhostHands setup and configuration
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

console.log('🔍 GhostHands Setup Verification\n');

// 1. Check environment variables
console.log('1️⃣  Environment Variables:');
const requiredEnvVars = [
  'DATABASE_URL',
  'DATABASE_DIRECT_URL',
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
];

const optionalEnvVars = [
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'SILICONFLOW_API_KEY',
];

let hasAllRequired = true;
for (const envVar of requiredEnvVars) {
  const value = process.env[envVar];
  if (value) {
    const display = value.length > 30 ? value.substring(0, 30) + '...' : value;
    console.log(`   ✅ ${envVar}: ${display}`);
  } else {
    console.log(`   ❌ ${envVar}: NOT SET`);
    hasAllRequired = false;
  }
}

console.log('\n   Optional LLM Provider Keys:');
for (const envVar of optionalEnvVars) {
  const value = process.env[envVar];
  if (value && value.trim()) {
    console.log(`   ✅ ${envVar}: Set`);
  } else {
    console.log(`   ⚠️  ${envVar}: Not set`);
  }
}

if (!hasAllRequired) {
  console.error('\n❌ Missing required environment variables!');
  process.exit(1);
}

// 2. Check database connection
console.log('\n2️⃣  Database Connection:');
const pool = new Pool({
  connectionString: process.env.DATABASE_DIRECT_URL,
});

try {
  const result = await pool.query('SELECT NOW()');
  console.log(`   ✅ Connected to database at ${result.rows[0].now}`);

  // Check if gh_user_usage table exists
  const tableCheck = await pool.query(`
    SELECT EXISTS (
      SELECT FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name = 'gh_user_usage'
    );
  `);

  if (tableCheck.rows[0].exists) {
    console.log('   ✅ Table gh_user_usage exists');
  } else {
    console.log('   ❌ Table gh_user_usage NOT found - run migration!');
  }
} catch (error) {
  console.error('   ❌ Database connection failed:', error);
  process.exit(1);
} finally {
  await pool.end();
}

// 3. Check package structure
console.log('\n3️⃣  Package Structure:');
const requiredFiles = [
  'src/api/server.ts',
  'src/workers/main.ts',
  'src/client/GhostHandsClient.ts',
  'src/db/migrations/001_gh_user_usage.sql',
  'src/config/models.config.json',
];

for (const file of requiredFiles) {
  const filePath = join(__dirname, '..', file.replace('src/', ''));
  try {
    readFileSync(filePath, 'utf8');
    console.log(`   ✅ ${file}`);
  } catch {
    console.log(`   ❌ ${file} NOT found`);
  }
}

console.log('\n✅ Setup verification complete!\n');
console.log('📝 Next steps:');
console.log('   1. Terminal 1: bun run api:dev     # Start API server on port 3000');
console.log('   2. Terminal 2: bun run worker:dev  # Start job worker');
console.log('   3. Terminal 3: bun run test:e2e    # Run E2E tests\n');
