#!/usr/bin/env bun
/**
 * Apply Web UI — Simple web page for submitting job applications.
 *
 * Paste a job URL, tweak user profile if needed, and submit.
 * The running worker picks up the job and fills out the application.
 *
 * Prerequisites:
 *   1. Worker running: bun run worker -- --worker-id=<name>
 *   2. .env loaded with DATABASE_URL (or SUPABASE_DIRECT_URL)
 *
 * Usage:
 *   bun src/scripts/apply-web.ts                # starts on port 3200
 *   bun src/scripts/apply-web.ts --port=8080    # custom port
 */

import { Hono } from 'hono';
import { Client as PgClient } from 'pg';

// --- Config ---

const DEFAULT_PORT = 3200;
const TEST_USER_ID = process.env.GH_TEST_USER_ID || '00000000-0000-0000-0000-000000000001';

function getDbUrl(): string {
  const url =
    process.env.DATABASE_URL ||
    process.env.SUPABASE_DIRECT_URL ||
    process.env.DATABASE_DIRECT_URL;
  if (!url) {
    console.error('Error: DATABASE_URL must be set in .env');
    process.exit(1);
  }
  return url;
}

function parsePort(): number {
  const arg = process.argv.find((a) => a.startsWith('--port='));
  if (arg) return parseInt(arg.split('=')[1], 10) || DEFAULT_PORT;
  return DEFAULT_PORT;
}

// --- DB helpers ---

async function createJob(body: any): Promise<any> {
  const dbUrl = getDbUrl();
  const client = new PgClient({ connectionString: dbUrl });
  await client.connect();

  try {
    const inputData = {
      user_data: body.user_data,
      qa_overrides: body.qa_overrides || {},
      tier: 'starter',
      platform: 'generic',
    };

    const taskDescription = [
      'Fill out the entire job application.',
      'Sign in with Google if prompted.',
      'Fill all required fields using the provided user data.',
      'For any optional self-identification questions, select "I do not wish to answer" or "Decline to self-identify".',
      'IMPORTANT: Do NOT click "Submit Application" — stop at the review/summary page.',
    ].join(' ');

    const result = await client.query(
      `INSERT INTO gh_automation_jobs (
        job_type, target_url, task_description,
        input_data, user_id, status,
        timeout_seconds, max_retries, priority,
        target_worker_id, tags
      ) VALUES (
        'smart_apply', $1, $2, $3::jsonb, $4,
        'pending', 600, 1, 1, $5, $6::jsonb
      )
      RETURNING id, status, target_url, created_at`,
      [
        body.target_url,
        taskDescription,
        JSON.stringify(inputData),
        TEST_USER_ID,
        body.worker_id || null,
        JSON.stringify(['web-ui', 'test']),
      ],
    );

    return result.rows[0];
  } finally {
    await client.end();
  }
}

async function getJobStatus(jobId: string): Promise<any> {
  const dbUrl = getDbUrl();
  const client = new PgClient({ connectionString: dbUrl });
  await client.connect();

  try {
    const jobResult = await client.query(
      `SELECT id, status, result_data, error_details, error_code,
              result_summary, started_at, completed_at, created_at
       FROM gh_automation_jobs WHERE id = $1`,
      [jobId],
    );

    const eventsResult = await client.query(
      `SELECT event_type, message, metadata, created_at
       FROM gh_job_events WHERE job_id = $1
       ORDER BY created_at ASC`,
      [jobId],
    );

    return {
      job: jobResult.rows[0] || null,
      events: eventsResult.rows,
    };
  } finally {
    await client.end();
  }
}

// --- Hono app ---

const app = new Hono();

app.get('/', (c) => {
  const html = PAGE_HTML.replace('__EMAIL_PLACEHOLDER__', process.env.TEST_GMAIL_EMAIL || '');
  return c.html(html);
});

app.post('/api/submit', async (c) => {
  try {
    const body = await c.req.json();
    if (!body.target_url) {
      return c.json({ error: 'target_url is required' }, 400);
    }
    if (!body.user_data?.email) {
      return c.json({ error: 'user_data.email is required' }, 400);
    }
    const job = await createJob(body);
    return c.json({ ok: true, job });
  } catch (err: any) {
    console.error('Error creating job:', err);
    return c.json({ error: err.message || 'Failed to create job' }, 500);
  }
});

app.get('/api/status/:id', async (c) => {
  try {
    const data = await getJobStatus(c.req.param('id'));
    if (!data.job) {
      return c.json({ error: 'Job not found' }, 404);
    }
    return c.json(data);
  } catch (err: any) {
    console.error('Error fetching status:', err);
    return c.json({ error: err.message || 'Failed to fetch status' }, 500);
  }
});

// --- Start server ---

const port = parsePort();
console.log(`\n  Apply Web UI running at http://localhost:${port}\n`);
console.log('  Make sure a worker is running:  bun run worker\n');

export default {
  port,
  fetch: app.fetch,
};

// --- Embedded HTML ---

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>GhostHands — Apply</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0a0a0a; color: #e0e0e0;
    min-height: 100vh; padding: 2rem;
  }
  .container { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.5rem; font-weight: 600; margin-bottom: 0.25rem; }
  .subtitle { color: #888; font-size: 0.85rem; margin-bottom: 2rem; }
  label { display: block; font-size: 0.8rem; color: #aaa; margin-bottom: 0.25rem; font-weight: 500; }
  input, textarea, select {
    width: 100%; padding: 0.6rem 0.75rem;
    background: #1a1a1a; border: 1px solid #333; border-radius: 6px;
    color: #e0e0e0; font-size: 0.9rem; outline: none;
    transition: border-color 0.15s;
  }
  input:focus, textarea:focus { border-color: #4a9eff; }
  .field { margin-bottom: 1rem; }
  .url-field input {
    font-size: 1rem; padding: 0.75rem 1rem;
    border-color: #4a9eff44;
  }
  .row { display: flex; gap: 1rem; }
  .row > .field { flex: 1; }
  .section {
    background: #111; border: 1px solid #222; border-radius: 8px;
    margin-bottom: 1.25rem; overflow: hidden;
  }
  .section-header {
    padding: 0.75rem 1rem; cursor: pointer;
    display: flex; justify-content: space-between; align-items: center;
    font-size: 0.85rem; font-weight: 600; color: #ccc;
    user-select: none;
  }
  .section-header:hover { background: #1a1a1a; }
  .section-body { padding: 0 1rem 1rem; }
  .section.collapsed .section-body { display: none; }
  .chevron { transition: transform 0.15s; font-size: 0.7rem; color: #666; }
  .section.collapsed .chevron { transform: rotate(-90deg); }
  button.submit {
    width: 100%; padding: 0.8rem;
    background: #4a9eff; color: #fff; border: none; border-radius: 6px;
    font-size: 0.95rem; font-weight: 600; cursor: pointer;
    transition: background 0.15s;
  }
  button.submit:hover { background: #3a8eef; }
  button.submit:disabled { opacity: 0.5; cursor: not-allowed; }
  .status-panel {
    margin-top: 1.5rem; background: #111; border: 1px solid #222;
    border-radius: 8px; padding: 1rem; display: none;
  }
  .status-header {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 0.75rem;
  }
  .status-badge {
    font-size: 0.75rem; font-weight: 600; padding: 0.2rem 0.6rem;
    border-radius: 10px; text-transform: uppercase;
  }
  .status-pending { background: #333; color: #aaa; }
  .status-running { background: #1a3a1a; color: #4caf50; }
  .status-completed { background: #1a3a1a; color: #4caf50; }
  .status-failed { background: #3a1a1a; color: #f44336; }
  .status-cancelled { background: #3a2a1a; color: #ff9800; }
  .status-paused { background: #1a2a3a; color: #2196f3; }
  .job-id { font-size: 0.75rem; color: #666; font-family: monospace; }
  .events {
    max-height: 300px; overflow-y: auto; font-size: 0.8rem;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .event {
    padding: 0.3rem 0; border-bottom: 1px solid #1a1a1a;
    display: flex; gap: 0.75rem;
  }
  .event-time { color: #555; white-space: nowrap; min-width: 70px; }
  .event-type { color: #4a9eff; min-width: 100px; }
  .event-msg { color: #ccc; word-break: break-word; }
  .qa-pair { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; align-items: start; }
  .qa-pair input:first-child { flex: 2; }
  .qa-pair input:last-of-type { flex: 1; }
  .qa-pair button {
    background: none; border: 1px solid #444; color: #888;
    border-radius: 4px; padding: 0.4rem 0.6rem; cursor: pointer;
    font-size: 0.8rem; white-space: nowrap;
  }
  .qa-pair button:hover { border-color: #f44336; color: #f44336; }
  .add-btn {
    background: none; border: 1px dashed #444; color: #888;
    border-radius: 4px; padding: 0.4rem 0.75rem; cursor: pointer;
    font-size: 0.8rem; margin-top: 0.25rem;
  }
  .add-btn:hover { border-color: #4a9eff; color: #4a9eff; }
  textarea { resize: vertical; min-height: 3.5rem; font-family: inherit; }
</style>
</head>
<body>
<div class="container">
  <h1>GhostHands Apply</h1>
  <p class="subtitle">Paste a job application URL. A running worker will fill it out.</p>

  <form id="applyForm" onsubmit="return handleSubmit(event)">
    <!-- URL -->
    <div class="field url-field">
      <label>Job Application URL *</label>
      <input type="url" id="targetUrl" placeholder="https://careers.google.com/jobs/..." required />
    </div>

    <!-- Worker ID -->
    <div class="field">
      <label>Worker ID (optional — leave empty for any worker)</label>
      <input type="text" id="workerId" placeholder="e.g. adam" />
    </div>

    <!-- Profile -->
    <div class="section" id="profileSection">
      <div class="section-header" onclick="toggleSection('profileSection')">
        <span>User Profile</span>
        <span class="chevron">&#9660;</span>
      </div>
      <div class="section-body">
        <div class="row">
          <div class="field">
            <label>First Name *</label>
            <input type="text" id="firstName" value="Happy" required />
          </div>
          <div class="field">
            <label>Last Name *</label>
            <input type="text" id="lastName" value="Wu" required />
          </div>
        </div>
        <div class="row">
          <div class="field">
            <label>Email *</label>
            <input type="email" id="email" value="__EMAIL_PLACEHOLDER__" required />
          </div>
          <div class="field">
            <label>Phone</label>
            <input type="tel" id="phone" value="4085551234" />
          </div>
        </div>
        <div class="row">
          <div class="field">
            <label>Current Company</label>
            <input type="text" id="currentCompany" value="WeKruit" />
          </div>
          <div class="field">
            <label>Current Title</label>
            <input type="text" id="currentTitle" value="Software Developer" />
          </div>
        </div>
        <div class="field">
          <label>LinkedIn URL</label>
          <input type="text" id="linkedin" value="www.linkedin.com/in/spencerwang1" />
        </div>

        <!-- Address -->
        <div class="row">
          <div class="field" style="flex:2">
            <label>Street</label>
            <input type="text" id="street" value="123 Test Avenue" />
          </div>
          <div class="field">
            <label>City</label>
            <input type="text" id="city" value="San Jose" />
          </div>
        </div>
        <div class="row">
          <div class="field">
            <label>State</label>
            <input type="text" id="state" value="California" />
          </div>
          <div class="field">
            <label>Zip</label>
            <input type="text" id="zip" value="95112" />
          </div>
          <div class="field">
            <label>Country</label>
            <input type="text" id="country" value="United States" />
          </div>
        </div>

        <!-- Education -->
        <div class="row">
          <div class="field" style="flex:2">
            <label>School</label>
            <input type="text" id="school" value="University of California, Los Angeles" />
          </div>
          <div class="field">
            <label>Degree</label>
            <input type="text" id="degree" value="Bachelor of Science" />
          </div>
        </div>
        <div class="row">
          <div class="field">
            <label>Field of Study</label>
            <input type="text" id="fieldOfStudy" value="Computer Science" />
          </div>
          <div class="field">
            <label>Graduation Year</label>
            <input type="text" id="gradYear" value="2023" />
          </div>
          <div class="field">
            <label>Years of Experience</label>
            <input type="number" id="yearsExp" value="3" />
          </div>
        </div>

        <div class="field">
          <label>Skills (comma-separated)</label>
          <input type="text" id="skills" value="Python, TypeScript, Go, Distributed Systems, Cloud Infrastructure" />
        </div>

        <div class="field">
          <label>Resume File Path</label>
          <input type="text" id="resumePath" value="resumeTemp.pdf" placeholder="Path to resume PDF" />
        </div>
      </div>
    </div>

    <!-- EEO / Self-ID -->
    <div class="section collapsed" id="eeoSection">
      <div class="section-header" onclick="toggleSection('eeoSection')">
        <span>EEO / Self-Identification</span>
        <span class="chevron">&#9660;</span>
      </div>
      <div class="section-body">
        <div class="row">
          <div class="field">
            <label>Gender</label>
            <input type="text" id="gender" value="Male" />
          </div>
          <div class="field">
            <label>Race/Ethnicity</label>
            <input type="text" id="raceEthnicity" value="Asian" />
          </div>
        </div>
        <div class="row">
          <div class="field">
            <label>Veteran Status</label>
            <input type="text" id="veteranStatus" value="I am not a protected veteran" />
          </div>
          <div class="field">
            <label>Disability Status</label>
            <input type="text" id="disabilityStatus" value="I do not wish to answer" />
          </div>
        </div>
        <div class="row">
          <div class="field">
            <label>Work Authorization</label>
            <input type="text" id="workAuth" value="Yes" />
          </div>
          <div class="field">
            <label>Visa Sponsorship Needed</label>
            <input type="text" id="visaSponsorship" value="No" />
          </div>
        </div>
      </div>
    </div>

    <!-- QA Overrides -->
    <div class="section collapsed" id="qaSection">
      <div class="section-header" onclick="toggleSection('qaSection')">
        <span>QA Overrides</span>
        <span class="chevron">&#9660;</span>
      </div>
      <div class="section-body">
        <p style="font-size:0.75rem;color:#666;margin-bottom:0.75rem;">
          Map exact question text to answers. These override the LLM's best guess.
        </p>
        <div id="qaList">
          <div class="qa-pair">
            <input type="text" placeholder="Question" value="Are you legally authorized to work in the United States?" />
            <input type="text" placeholder="Answer" value="Yes" />
            <button type="button" onclick="this.parentElement.remove()">x</button>
          </div>
          <div class="qa-pair">
            <input type="text" placeholder="Question" value="Will you now or in the future require sponsorship for employment visa status?" />
            <input type="text" placeholder="Answer" value="No" />
            <button type="button" onclick="this.parentElement.remove()">x</button>
          </div>
          <div class="qa-pair">
            <input type="text" placeholder="Question" value="Are you at least 18 years of age?" />
            <input type="text" placeholder="Answer" value="Yes" />
            <button type="button" onclick="this.parentElement.remove()">x</button>
          </div>
          <div class="qa-pair">
            <input type="text" placeholder="Question" value="Have you previously worked for this company?" />
            <input type="text" placeholder="Answer" value="No" />
            <button type="button" onclick="this.parentElement.remove()">x</button>
          </div>
        </div>
        <button type="button" class="add-btn" onclick="addQaPair()">+ Add override</button>
      </div>
    </div>

    <button type="submit" class="submit" id="submitBtn">Submit Job</button>
  </form>

  <!-- Status Panel -->
  <div class="status-panel" id="statusPanel">
    <div class="status-header">
      <div>
        <span class="status-badge" id="statusBadge">pending</span>
        <span class="job-id" id="jobIdLabel"></span>
      </div>
    </div>
    <div class="events" id="eventsList"></div>
  </div>
</div>

<script>
let currentJobId = null;
let pollTimer = null;

function toggleSection(id) {
  document.getElementById(id).classList.toggle('collapsed');
}

function addQaPair() {
  const list = document.getElementById('qaList');
  const div = document.createElement('div');
  div.className = 'qa-pair';
  div.innerHTML =
    '<input type="text" placeholder="Question" />' +
    '<input type="text" placeholder="Answer" />' +
    '<button type="button" onclick="this.parentElement.remove()">x</button>';
  list.appendChild(div);
}

function buildPayload() {
  const qa = {};
  document.querySelectorAll('#qaList .qa-pair').forEach(row => {
    const inputs = row.querySelectorAll('input');
    const q = inputs[0].value.trim();
    const a = inputs[1].value.trim();
    if (q && a) qa[q] = a;
  });

  return {
    target_url: document.getElementById('targetUrl').value.trim(),
    worker_id: document.getElementById('workerId').value.trim() || null,
    user_data: {
      first_name: document.getElementById('firstName').value.trim(),
      last_name: document.getElementById('lastName').value.trim(),
      email: document.getElementById('email').value.trim(),
      phone: document.getElementById('phone').value.trim(),
      address: {
        street: document.getElementById('street').value.trim(),
        city: document.getElementById('city').value.trim(),
        state: document.getElementById('state').value.trim(),
        zip: document.getElementById('zip').value.trim(),
        country: document.getElementById('country').value.trim(),
      },
      linkedin_url: document.getElementById('linkedin').value.trim(),
      current_company: document.getElementById('currentCompany').value.trim(),
      current_title: document.getElementById('currentTitle').value.trim(),
      years_of_experience: parseInt(document.getElementById('yearsExp').value) || 0,
      education: [{
        school: document.getElementById('school').value.trim(),
        degree: document.getElementById('degree').value.trim(),
        field_of_study: document.getElementById('fieldOfStudy').value.trim(),
        graduation_year: document.getElementById('gradYear').value.trim(),
      }],
      experience: [{
        company: document.getElementById('currentCompany').value.trim(),
        title: document.getElementById('currentTitle').value.trim(),
        currently_work_here: true,
        start_date: '2023-06',
        description: 'Software development.',
      }],
      skills: document.getElementById('skills').value.split(',').map(s => s.trim()).filter(Boolean),
      resume_path: document.getElementById('resumePath').value.trim() || undefined,
      work_authorization: document.getElementById('workAuth').value.trim(),
      visa_sponsorship: document.getElementById('visaSponsorship').value.trim(),
      gender: document.getElementById('gender').value.trim(),
      race_ethnicity: document.getElementById('raceEthnicity').value.trim(),
      veteran_status: document.getElementById('veteranStatus').value.trim(),
      disability_status: document.getElementById('disabilityStatus').value.trim(),
    },
    qa_overrides: qa,
  };
}

async function handleSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = 'Creating job...';

  try {
    const res = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload()),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Submit failed');

    currentJobId = data.job.id;
    document.getElementById('jobIdLabel').textContent = currentJobId;
    document.getElementById('statusPanel').style.display = 'block';
    updateBadge('pending');
    startPolling();
    btn.textContent = 'Job Submitted';
  } catch (err) {
    alert('Error: ' + err.message);
    btn.disabled = false;
    btn.textContent = 'Submit Job';
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollStatus, 2000);
  pollStatus();
}

async function pollStatus() {
  if (!currentJobId) return;
  try {
    const res = await fetch('/api/status/' + currentJobId);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.job) return;

    updateBadge(data.job.status);
    renderEvents(data.events);

    // Stop polling on terminal states
    if (['completed', 'failed', 'cancelled'].includes(data.job.status)) {
      clearInterval(pollTimer);
      pollTimer = null;
      const btn = document.getElementById('submitBtn');
      btn.disabled = false;
      btn.textContent = 'Submit Another Job';
    }
  } catch { /* ignore poll errors */ }
}

function updateBadge(status) {
  const badge = document.getElementById('statusBadge');
  badge.textContent = status;
  badge.className = 'status-badge status-' + status;
}

function renderEvents(events) {
  const el = document.getElementById('eventsList');
  el.innerHTML = events.map(ev => {
    const t = new Date(ev.created_at);
    const time = t.toLocaleTimeString('en-US', { hour12: false });
    const msg = ev.message || '';
    return '<div class="event">' +
      '<span class="event-time">' + time + '</span>' +
      '<span class="event-type">' + (ev.event_type || '') + '</span>' +
      '<span class="event-msg">' + escapeHtml(msg) + '</span>' +
      '</div>';
  }).join('');
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
</script>
</body>
</html>`;
