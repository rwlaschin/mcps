/**
 * Default processor for scanProject: analyzes each path via analyzeFile (reads file, calls LLM).
 * Used when no processor is passed so scanner itself never opens files.
 */
import { analyzeFile } from '../analyzer';

export interface ScanResult {
  file: string;
  summary: string;
}

export function createDefaultScanProcessor(projectKey: string): (filePath: string) => Promise<ScanResult | null> {
  return async (filePath: string): Promise<ScanResult | null> => {
    try {
      const summary = await analyzeFile(projectKey, filePath);
      return { file: filePath, summary };
    } catch {
      return null;
    }
  };
}
