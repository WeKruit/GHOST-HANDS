import { Hono } from 'hono';
import { JobController } from '../controllers/jobs.js';
import { getAuth, resolveUserId, validateBody, validateQuery } from '../middleware/index.js';
import { rateLimitMiddleware } from '../../security/rateLimit.js';
import {
  CreateJobSchema,
  BatchCreateJobsSchema,
  ListJobsQuerySchema,
  GetEventsQuerySchema,
} from '../schemas/index.js';
import type {
  CreateJobInput,
  BatchCreateJobsInput,
  ListJobsQuery,
  GetEventsQuery,
} from '../schemas/index.js';

type AppVariables = {
  validatedBody: unknown;
  validatedQuery: unknown;
};

export function createJobRoutes(controller: JobController) {
  const jobs = new Hono<{ Variables: AppVariables }>();

  // ─── POST /jobs - Create Job ───────────────────────────────────

  jobs.post('/', rateLimitMiddleware(), validateBody(CreateJobSchema), async (c) => {
    const auth = getAuth(c);
    const body = c.get('validatedBody') as CreateJobInput;
    const userId = resolveUserId(c, (body as any).user_id);

    if (!userId) {
      return c.json(
        { error: 'validation_error', message: 'user_id is required' },
        422,
      );
    }

    const result = await controller.createJob(body, userId, auth.type === 'service' ? 'valet' : 'api');

    if (result.conflict) {
      return c.json(
        {
          error: 'duplicate_idempotency_key',
          existing_job_id: result.existing_job_id,
          existing_status: result.existing_status,
        },
        409,
      );
    }

    return c.json(result.job, 201);
  });

  // ─── POST /jobs/batch - Batch Create Jobs ──────────────────────

  jobs.post('/batch', rateLimitMiddleware(), validateBody(BatchCreateJobsSchema), async (c) => {
    const auth = getAuth(c);
    const body = c.get('validatedBody') as BatchCreateJobsInput;
    const userId = resolveUserId(c, (body as any).user_id);

    if (!userId) {
      return c.json(
        { error: 'validation_error', message: 'user_id is required' },
        422,
      );
    }

    const result = await controller.batchCreateJobs(
      body,
      userId,
      auth.type === 'service' ? 'valet' : 'api',
    );

    return c.json(result, 201);
  });

  // ─── GET /jobs - List Jobs ─────────────────────────────────────

  jobs.get('/', validateQuery(ListJobsQuerySchema), async (c) => {
    const auth = getAuth(c);
    const query = c.get('validatedQuery') as ListJobsQuery;

    // User callers can only see their own jobs
    const scopedUserId = auth.type === 'user' ? auth.userId : undefined;

    const result = await controller.listJobs(query, scopedUserId);
    return c.json(result);
  });

  // ─── GET /jobs/:id - Get Job ───────────────────────────────────

  jobs.get('/:id', async (c) => {
    const jobId = c.req.param('id');
    const auth = getAuth(c);
    const scopedUserId = auth.type === 'user' ? auth.userId : undefined;

    const job = await controller.getJob(jobId, scopedUserId);
    if (!job) {
      return c.json({ error: 'not_found', message: 'Job not found' }, 404);
    }

    return c.json(job);
  });

  // ─── GET /jobs/:id/status - Get Job Status (Lightweight) ──────

  jobs.get('/:id/status', async (c) => {
    const jobId = c.req.param('id');
    const auth = getAuth(c);
    const scopedUserId = auth.type === 'user' ? auth.userId : undefined;

    const status = await controller.getJobStatus(jobId, scopedUserId);
    if (!status) {
      return c.json({ error: 'not_found', message: 'Job not found' }, 404);
    }

    return c.json(status);
  });

  // ─── POST /jobs/:id/cancel - Cancel Job ───────────────────────

  jobs.post('/:id/cancel', async (c) => {
    const jobId = c.req.param('id');
    const auth = getAuth(c);
    const scopedUserId = auth.type === 'user' ? auth.userId : undefined;

    const result = await controller.cancelJob(jobId, scopedUserId);

    if (result.notFound) {
      return c.json({ error: 'not_found', message: 'Job not found' }, 404);
    }

    if ('notCancellable' in result && result.notCancellable) {
      return c.json(
        {
          error: 'job_not_cancellable',
          current_status: result.current_status,
        },
        409,
      );
    }

    return c.json(result.job);
  });

  // ─── GET /jobs/:id/events - Get Job Events ────────────────────

  jobs.get('/:id/events', validateQuery(GetEventsQuerySchema), async (c) => {
    const jobId = c.req.param('id');
    const auth = getAuth(c);
    const scopedUserId = auth.type === 'user' ? auth.userId : undefined;
    const query = c.get('validatedQuery') as GetEventsQuery;

    const result = await controller.getJobEvents(jobId, query, scopedUserId);
    if (!result) {
      return c.json({ error: 'not_found', message: 'Job not found' }, 404);
    }

    return c.json(result);
  });

  // ─── POST /jobs/:id/retry - Retry Job ─────────────────────────

  jobs.post('/:id/retry', async (c) => {
    const jobId = c.req.param('id');
    const auth = getAuth(c);
    const scopedUserId = auth.type === 'user' ? auth.userId : undefined;

    const result = await controller.retryJob(jobId, scopedUserId);

    if (result.notFound) {
      return c.json({ error: 'not_found', message: 'Job not found' }, 404);
    }

    if ('notRetryable' in result && result.notRetryable) {
      return c.json(
        {
          error: 'job_not_retryable',
          message: `Job with status '${result.current_status}' cannot be retried. Only failed or cancelled jobs can be retried.`,
          current_status: result.current_status,
        },
        409,
      );
    }

    return c.json(result.job);
  });

  return jobs;
}
