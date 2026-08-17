import { Agent } from './models/Agent';
import { logger } from '../logger';

/**
 * One-time shape fix for existing documents: `focus` → `tool_name`,
 * `seed_baseline_focus` → `seed_baseline_tool_name`.
 * Safe to run on every connect (no-ops when already migrated).
 */
export async function migrateAgentFocusToToolName(): Promise<void> {
  try {
    const coll = Agent.collection;
    const r1 = await coll.updateMany(
      { tool_name: { $exists: false }, focus: { $exists: true } },
      // Aggregation pipeline update (MongoDB 4.2+)
      [{ $set: { tool_name: '$focus' } }, { $unset: 'focus' }] as never[]
    );
    const r2 = await coll.updateMany(
      {
        seed_baseline_tool_name: { $exists: false },
        seed_baseline_focus: { $exists: true }
      },
      [{ $set: { seed_baseline_tool_name: '$seed_baseline_focus' } }, { $unset: 'seed_baseline_focus' }] as never[]
    );
    if (r1.modifiedCount > 0 || r2.modifiedCount > 0) {
      logger.info({
        event: 'agent_tool_name_migration',
        focusRenamed: r1.modifiedCount,
        seedBaselineRenamed: r2.modifiedCount
      });
    }
  } catch (err) {
    logger.warn({ event: 'agent_tool_name_migration_failed', err });
  }
}
