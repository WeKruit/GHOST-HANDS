import { Hono } from 'hono';
import pg from 'pg';
import { validateBody } from '../middleware/index.js';
import { rateLimitMiddleware } from '../../security/rateLimit.js';
import { ValetApplySchema, ValetTaskSchema } from '../schemas/valet.js';
import type { ValetApplyInput, ValetTaskInput } from '../schemas/valet.js';

type AppVariables = {
  validatedBody: unknown;
};

export function createValetRoutes(pool: pg.Pool) {
  const valet = new Hono<{ Variables: AppVariables }>();

  // ─── POST /valet/apply — Rich application request ─────────────

  valet.post('/apply', rateLimitMiddleware(), validateBody(ValetApplySchema), async (c) => {
    const body = c.get('validatedBody') as ValetApplyInput;

    const taskDescription = `Apply to the job posting. Fill in all required fields using the provided profile information. Upload resume if required.`;

    // Transform profile into input_data.user_data format
    const userData: Record<string, any> = {
      first_name: body.profile.first_name,
      last_name: body.profile.last_name,
      email: body.profile.email,
      phone: body.profile.phone,
      linkedin_url: body.profile.linkedin_url,
      portfolio_url: body.profile.portfolio_url,
      work_authorization: body.profile.work_authorization,
      salary_expectation: body.profile.salary_expectation,
      years_of_experience: body.profile.years_of_experience,
    };

    if (body.profile.location) {
      userData.city = body.profile.location.city;
      userData.state = body.profile.location.state;
      userData.country = body.profile.location.country;
      userData.zip = body.profile.location.zip;
    }

    if (body.profile.education?.length) {
      userData.education = body.profile.education;
    }
    if (body.profile.work_history?.length) {
      userData.work_history = body.profile.work_history;
    }
    if (body.profile.skills?.length) {
      userData.skills = body.profile.skills;
    }

    // Check idempotency
    if (body.idempotency_key) {
      const existing = await pool.query(
        'SELECT id, status FROM gh_automation_jobs WHERE idempotency_key = $1 LIMIT 1',
        [body.idempotency_key]
      );
      if (existing.rows.length > 0) {
        return c.json({
          job_id: existing.rows[0].id,
          valet_task_id: body.valet_task_id,
          status: existing.rows[0].status,
          duplicate: true,
        }, 409);
      }
    }

    // Build metadata with VALET-specific fields as backup
    const metadata = {
      ...body.metadata,
      source: 'valet',
      quality_preset: body.quality,
      valet_task_id: body.valet_task_id,
      callback_url: body.callback_url || null,
      resume_ref: body.resume || null,
    };

    // Insert job — uses core columns; VALET-specific columns (callback_url,
    // valet_task_id, resume_ref) are stored in metadata as backup until the
    // DB migration adds them as dedicated columns.
    const result = await pool.query(`
      INSERT INTO gh_automation_jobs (
        user_id, created_by, job_type, target_url, task_description,
        input_data, priority, max_retries, timeout_seconds,
        tags, idempotency_key, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id, status, created_at
    `, [
      body.valet_user_id,
      'valet',
      'apply',
      body.target_url,
      taskDescription,
      JSON.stringify({
        user_data: userData,
        qa_overrides: body.qa_answers || {},
        tier: body.quality === 'quality' ? 'pro' : body.quality === 'speed' ? 'free' : 'starter',
        platform: body.platform || 'other',
      }),
      body.priority,
      3,
      body.timeout_seconds,
      JSON.stringify(['valet', 'apply']),
      body.idempotency_key || null,
      JSON.stringify(metadata),
    ]);

    const job = result.rows[0];

    return c.json({
      job_id: job.id,
      valet_task_id: body.valet_task_id,
      status: job.status,
      created_at: job.created_at,
    }, 201);
  });

  // ─── POST /valet/task — Generic task request ──────────────────

  valet.post('/task', rateLimitMiddleware(), validateBody(ValetTaskSchema), async (c) => {
    const body = c.get('validatedBody') as ValetTaskInput;

    if (body.idempotency_key) {
      const existing = await pool.query(
        'SELECT id, status FROM gh_automation_jobs WHERE idempotency_key = $1 LIMIT 1',
        [body.idempotency_key]
      );
      if (existing.rows.length > 0) {
        return c.json({
          job_id: existing.rows[0].id,
          valet_task_id: body.valet_task_id,
          status: existing.rows[0].status,
          duplicate: true,
        }, 409);
      }
    }

    const metadata = {
      ...body.metadata,
      source: 'valet',
      quality_preset: body.quality,
      valet_task_id: body.valet_task_id,
      callback_url: body.callback_url || null,
    };

    const result = await pool.query(`
      INSERT INTO gh_automation_jobs (
        user_id, created_by, job_type, target_url, task_description,
        input_data, priority, max_retries, timeout_seconds,
        tags, idempotency_key, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id, status, created_at
    `, [
      body.valet_user_id,
      'valet',
      body.job_type,
      body.target_url,
      body.task_description,
      JSON.stringify(body.input_data),
      body.priority,
      3,
      body.timeout_seconds,
      JSON.stringify(['valet', body.job_type]),
      body.idempotency_key || null,
      JSON.stringify(metadata),
    ]);

    const job = result.rows[0];

    return c.json({
      job_id: job.id,
      valet_task_id: body.valet_task_id,
      status: job.status,
      created_at: job.created_at,
    }, 201);
  });

  // ─── GET /valet/status/:jobId — VALET-compatible status ───────

  valet.get('/status/:jobId', async (c) => {
    const jobId = c.req.param('jobId');

    const { rows } = await pool.query(`
      SELECT id, status, status_message, result_data, result_summary,
             error_code, error_details, screenshot_urls,
             started_at, completed_at, created_at,
             metadata
      FROM gh_automation_jobs WHERE id = $1::UUID
    `, [jobId]);

    if (rows.length === 0) {
      return c.json({ error: 'not_found', message: 'Job not found' }, 404);
    }

    const job = rows[0];
    const meta = typeof job.metadata === 'string' ? JSON.parse(job.metadata) : (job.metadata || {});

    return c.json({
      job_id: job.id,
      valet_task_id: meta.valet_task_id || null,
      status: job.status,
      status_message: job.status_message,
      progress: meta.progress || null,
      result: job.status === 'completed' ? {
        data: job.result_data,
        summary: job.result_summary,
        screenshots: job.screenshot_urls,
      } : null,
      error: job.status === 'failed' ? {
        code: job.error_code,
        details: job.error_details,
      } : null,
      timestamps: {
        created_at: job.created_at,
        started_at: job.started_at,
        completed_at: job.completed_at,
      },
    });
  });

  return valet;
}
