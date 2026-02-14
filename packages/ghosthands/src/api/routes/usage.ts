import { Hono } from 'hono';
import { getAuth } from '../middleware/auth.js';
import { CostControlService } from '../../workers/costControl.js';
import { getSupabaseClient } from '../../db/client.js';

/**
 * Usage routes: GET /users/:id/usage
 *
 * Returns current-month cost, remaining budget, and job count for a user.
 * Service callers can query any user; user callers can only see their own.
 */
export function createUsageRoutes(): Hono {
  const usage = new Hono();

  usage.get('/users/:id/usage', async (c) => {
    const targetUserId = c.req.param('id');
    const auth = getAuth(c);

    // User callers can only view their own usage
    if (auth.type === 'user' && auth.userId !== targetUserId) {
      return c.json(
        { error: 'forbidden', message: 'Cannot view another user\'s usage' },
        403,
      );
    }

    const supabase = getSupabaseClient();
    const costService = new CostControlService(supabase);

    const userUsage = await costService.getUserUsage(targetUserId);

    return c.json({
      user_id: userUsage.userId,
      tier: userUsage.tier,
      monthly_budget_usd: userUsage.monthlyBudget,
      current_month_cost_usd: userUsage.currentMonthCost,
      remaining_budget_usd: userUsage.remainingBudget,
      job_count: userUsage.jobCount,
      period_start: userUsage.periodStart,
      period_end: userUsage.periodEnd,
    });
  });

  return usage;
}
