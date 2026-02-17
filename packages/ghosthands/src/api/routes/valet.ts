import { Hono } from 'hono';
import pg from 'pg';
import { validateBody } from '../middleware/index.js';
import { rateLimitMiddleware } from '../../security/rateLimit.js';
import { ValetApplySchema, ValetTaskSchema, ValetResumeSchema } from '../schemas/valet.js';
import type { ValetApplyInput, ValetTaskInput, ValetResumeInput } from '../schemas/valet.js';

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

    // Insert job — includes VALET-specific columns (callback_url, valet_task_id)
    // added in migration 005. Also stored in metadata as backup.
    // execution_mode column added in migration 011.
    const result = await pool.query(`
      INSERT INTO gh_automation_jobs (
        user_id, created_by, job_type, target_url, task_description,
        input_data, priority, max_retries, timeout_seconds,
        tags, idempotency_key, metadata, target_worker_id,
        callback_url, valet_task_id, execution_mode
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
        ...(body.model ? { model: body.model } : {}),
        ...(body.image_model ? { image_model: body.image_model } : {}),
      }),
      body.priority,
      3,
      body.timeout_seconds,
      JSON.stringify(['valet', 'apply']),
      body.idempotency_key || null,
      JSON.stringify(metadata),
      body.target_worker_id || null,
      body.callback_url || null,
      body.valet_task_id,
      body.execution_mode,
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

    // Store model/image_model in input_data so JobExecutor reads them
    const inputData = {
      ...body.input_data,
      ...(body.model ? { model: body.model } : {}),
      ...(body.image_model ? { image_model: body.image_model } : {}),
    };

    const result = await pool.query(`
      INSERT INTO gh_automation_jobs (
        user_id, created_by, job_type, target_url, task_description,
        input_data, priority, max_retries, timeout_seconds,
        tags, idempotency_key, metadata, target_worker_id,
        callback_url, valet_task_id, execution_mode
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING id, status, created_at
    `, [
      body.valet_user_id,
      'valet',
      body.job_type,
      body.target_url,
      body.task_description,
      JSON.stringify(inputData),
      body.priority,
      3,
      body.timeout_seconds,
      JSON.stringify(['valet', body.job_type]),
      body.idempotency_key || null,
      JSON.stringify(metadata),
      body.target_worker_id || null,
      body.callback_url || null,
      body.valet_task_id,
      body.execution_mode,
    ]);

    const job = result.rows[0];

    return c.json({
      job_id: job.id,
      valet_task_id: body.valet_task_id,
      status: job.status,
      created_at: job.created_at,
    }, 201);
  });

  // ─── POST /valet/resume/:jobId — Resume a paused job ─────────

  valet.post('/resume/:jobId', rateLimitMiddleware(), validateBody(ValetResumeSchema), async (c) => {
    const jobId = c.req.param('jobId');
    const body = c.get('validatedBody') as ValetResumeInput;

    // Verify job exists and is paused
    const { rows } = await pool.query(
      'SELECT id, status FROM gh_automation_jobs WHERE id = $1::UUID',
      [jobId]
    );

    if (rows.length === 0) {
      return c.json({ error: 'not_found', message: 'Job not found' }, 404);
    }

    if (rows[0].status !== 'paused') {
      return c.json({
        error: 'invalid_state',
        message: `Job is not paused (current status: ${rows[0].status})`,
      }, 409);
    }

    // Fire NOTIFY so the listening JobExecutor picks up the resume signal
    await pool.query("SELECT pg_notify('gh_job_resume', $1)", [jobId]);

    // Update job status back to running
    await pool.query(`
      UPDATE gh_automation_jobs
      SET status = 'running',
          paused_at = NULL,
          status_message = $2,
          updated_at = NOW()
      WHERE id = $1::UUID
    `, [jobId, `Resumed by ${body.resolved_by}${body.resolution_notes ? ': ' + body.resolution_notes : ''}`]);

    return c.json({
      job_id: jobId,
      status: 'running',
      resolved_by: body.resolved_by,
    });
  });

  // ─── GET /valet/sessions/:userId — List stored sessions ───────

  valet.get('/sessions/:userId', async (c) => {
    const userId = c.req.param('userId');

    const { rows } = await pool.query(`
      SELECT domain, last_used_at, created_at, updated_at, expires_at
      FROM gh_browser_sessions
      WHERE user_id = $1::UUID
      ORDER BY last_used_at DESC
    `, [userId]);

    return c.json({
      user_id: userId,
      sessions: rows.map((r) => ({
        domain: r.domain,
        last_used_at: r.last_used_at,
        created_at: r.created_at,
        updated_at: r.updated_at,
        expires_at: r.expires_at,
      })),
      count: rows.length,
    });
  });

  // ─── DELETE /valet/sessions/:userId/:domain — Clear one session ──

  valet.delete('/sessions/:userId/:domain', async (c) => {
    const userId = c.req.param('userId');
    const domain = decodeURIComponent(c.req.param('domain'));

    const { rowCount } = await pool.query(`
      DELETE FROM gh_browser_sessions
      WHERE user_id = $1::UUID AND domain = $2
    `, [userId, domain]);

    if (rowCount === 0) {
      return c.json({ error: 'not_found', message: 'No session found for this user/domain' }, 404);
    }

    return c.json({ user_id: userId, domain, deleted: true });
  });

  // ─── DELETE /valet/sessions/:userId — Clear all sessions ────────

  valet.delete('/sessions/:userId', async (c) => {
    const userId = c.req.param('userId');

    const { rowCount } = await pool.query(`
      DELETE FROM gh_browser_sessions
      WHERE user_id = $1::UUID
    `, [userId]);

    return c.json({
      user_id: userId,
      deleted_count: rowCount ?? 0,
    });
  });

  // ─── Helpers for status endpoint ──────────────────────────────

  function buildManualInfo(meta: Record<string, any>) {
    const engine = meta?.engine || {};
    if (!engine.manual_id) return null;
    return {
      id: engine.manual_id,
      status: engine.manual_status || 'ai_only',
      health_score: engine.health_score ?? null,
      fallback_reason: engine.fallback_reason ?? null,
    };
  }

  function buildCostBreakdown(job: Record<string, any>) {
    const resultCost = job.result_data?.cost;
    if (!resultCost) return null;

    const meta = typeof job.metadata === 'string' ? JSON.parse(job.metadata) : (job.metadata || {});
    const modeCosts = meta?.cost_breakdown || {};

    return {
      total_cost_usd: resultCost.total_cost_usd ?? 0,
      action_count: resultCost.action_count ?? 0,
      total_tokens: (resultCost.input_tokens ?? 0) + (resultCost.output_tokens ?? 0),
      cookbook_steps: modeCosts.cookbook_steps ?? 0,
      magnitude_steps: modeCosts.magnitude_steps ?? 0,
      cookbook_cost_usd: modeCosts.cookbook_cost_usd ?? 0,
      magnitude_cost_usd: modeCosts.magnitude_cost_usd ?? 0,
    };
  }

  // ─── GET /valet/status/:jobId — VALET-compatible status ───────

  valet.get('/status/:jobId', async (c) => {
    const jobId = c.req.param('jobId');

    const { rows } = await pool.query(`
      SELECT id, status, status_message, result_data, result_summary,
             error_code, error_details, screenshot_urls,
             interaction_type, interaction_data, paused_at,
             started_at, completed_at, created_at,
             metadata, callback_url, valet_task_id,
             execution_mode, browser_mode, final_mode
      FROM gh_automation_jobs WHERE id = $1::UUID
    `, [jobId]);

    if (rows.length === 0) {
      return c.json({ error: 'not_found', message: 'Job not found' }, 404);
    }

    const job = rows[0];
    const meta = typeof job.metadata === 'string' ? JSON.parse(job.metadata) : (job.metadata || {});

    const interactionInfo = job.interaction_data as Record<string, any> | null;

    return c.json({
      job_id: job.id,
      valet_task_id: job.valet_task_id || meta.valet_task_id || null,
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
      interaction: job.status === 'paused' && interactionInfo ? {
        type: job.interaction_type,
        screenshot_url: interactionInfo.screenshot_url || null,
        page_url: interactionInfo.page_url || null,
        paused_at: job.paused_at,
        timeout_seconds: 300,
      } : null,
      execution_mode: job.execution_mode || 'auto',
      browser_mode: job.browser_mode || 'server',
      final_mode: job.final_mode || null,
      manual: buildManualInfo(meta),
      cost_breakdown: buildCostBreakdown(job),
      timestamps: {
        created_at: job.created_at,
        started_at: job.started_at,
        completed_at: job.completed_at,
      },
    });
  });

  return valet;
}
