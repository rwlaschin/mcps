// Code Parser (Regex/AST for symbols) + vault-backed LLM summarization
import * as dotenv from 'dotenv';
import { getProjectRoot } from './scannerRequirements';
import { MODEL_CALL_CALLER_SCAN_ANALYZE, runFileProcessingLlm } from './llm/runFileProcessingLlm';

dotenv.config({ quiet: true });

/**
 * Summarize a file for indexing using the same stack as MCP file processing:
 * `SystemPrompt` for usage_type `file processor`, enabled `LLMModel` chain from Mongo, then `GEMINI_API_KEY` fallback.
 * Emits `operation: 'model_call'` with `caller: scan_analyze_file` (scan heatmap remains `operation: 'scan'`).
 */
export async function analyzeFile(projectKey: string, filePath: string): Promise<string> {
  const rootDir = await getProjectRoot(projectKey);
  const r = await runFileProcessingLlm({
    projectKey,
    filePath,
    rootDir,
    caller: MODEL_CALL_CALLER_SCAN_ANALYZE
  });
  return r.summary;
}
