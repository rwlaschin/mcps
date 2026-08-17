import { postMetric } from '../stats/metricsClient';
import { METRIC_OPERATION_MODEL_CALL } from './metricsConstants';
import type { LlmTokenUsage } from './tokenUsage';

export { METRIC_OPERATION_MODEL_CALL } from './metricsConstants';

const INSTANCE_ID = process.env.INSTANCE_ID ?? 'mcp-code-vault';

export type PostModelCallMetricParams = {
  projectKey: string;
  /** Stable pipeline id, e.g. `file_processing_watcher`, `scan_analyze_file`. */
  caller: string;
  durationMs: number;
  status: 'ok' | 'error';
  errorCode?: string;
  usage: LlmTokenUsage;
  provider?: string;
  modelId?: string;
  modelLabel?: string;
  /** Relative path when the call is file-scoped. */
  filePath?: string;
  /** Resolved policy, e.g. `prompt:my-slug` or `agent:tool_name`. */
  fileProcessingDriver?: string;
  continuationRounds?: number;
  outputTruncated?: boolean;
  lastFinishReason?: string;
};

/**
 * Emit `operation: 'model_call'` with UI-aligned `metadata.tokens_*` (snake_case) for Stats home percentiles.
 */
export async function postModelCallMetric(params: PostModelCallMetricParams): Promise<void> {
  const started_at = new Date(Date.now() - params.durationMs).toISOString();
  const ended_at = new Date().toISOString();
  const ti = params.usage.inputTokens;
  const to = params.usage.outputTokens;
  const tt = params.usage.thinkingTokens;
  await postMetric({
    instance_id: INSTANCE_ID,
    operation: METRIC_OPERATION_MODEL_CALL,
    kind: 'event',
    started_at,
    ended_at,
    duration_ms: params.durationMs,
    status: params.status,
    error_code: params.errorCode,
    metadata: {
      projectKey: params.projectKey,
      caller: params.caller,
      provider: params.provider,
      model_id: params.modelId,
      model_label: params.modelLabel,
      file_path: params.filePath,
      file_processing_driver: params.fileProcessingDriver,
      tokens_in: ti,
      tokens_out: to,
      tokens_thinking: tt,
      continuation_rounds: params.continuationRounds,
      output_truncated: params.outputTruncated,
      last_finish_reason: params.lastFinishReason
    }
  });
}
