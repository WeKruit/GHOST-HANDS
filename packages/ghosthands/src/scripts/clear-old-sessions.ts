#!/usr/bin/env node
/**
 * Clear old browser sessions from Supabase so the worker does a fresh login.
 *
 * Usage:
 *   npx tsx --env-file=.env src/scripts/clear-old-sessions.ts
 */
import { createClient } from '@supabase/supabase-js';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    console.error('Need SUPABASE_URL and SUPABASE_SECRET_KEY');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey);

  // Delete all stored sessions for the test user
  const { data, error } = await supabase
    .from('gh_browser_sessions')
    .delete()
    .eq('user_id', TEST_USER_ID)
    .select('id, domain');

  if (error) {
    console.error('Error clearing sessions:', error.message);
    process.exit(1);
  }

  if (data && data.length > 0) {
    console.log(`Cleared ${data.length} session(s):`);
    for (const row of data) {
      console.log(`  - ${row.domain} (id: ${row.id})`);
    }
  } else {
    console.log('No sessions found to clear.');
  }

  console.log('Done. Next worker run will do a fresh Google login.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
