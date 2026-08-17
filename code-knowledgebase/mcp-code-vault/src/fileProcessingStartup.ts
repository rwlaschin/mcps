/**
 * MCP client file processing:
 * - query FileProcessor checksum state from DB
 * - process file paths in configured batches
 * - set up watcher for incremental queueing
 * - run vault LLM (`runFileProcessingLlm`: Mongo prompts + model chain, Gemini env fallback) and report metrics
 */

import * as path from 'path';
import pLimit from 'p-limit';
import { getProjectRoot } from './scannerRequirements';
import { listFilesUnderRoot } from './scanner';
import { getFileProcessorChecksumMap } from './db/projectDb';
import { Project } from './db/models/Project';
import { postMetric } from './stats/metricsClient';
import { METRIC_OPERATION_READ } from './stats/fileReadHourBuckets';
import { calculateMD5 } from './utils/hasher';
import { createChokidarIgnored, logFileWatchIgnoreSummary, shouldIgnore } from './utils/ignore-mgr';
import { MODEL_CALL_CALLER_FILE_PROCESSING, runFileProcessingLlm } from './llm/runFileProcessingLlm';

const INSTANCE_ID = process.env.INSTANCE_ID ?? 'mcp-code-vault';

export const SCAN_METRIC_KEY = 'scan';
export const SCAN_ACTION_START = 'start';
export const SCAN_ACTION_UPDATE = 'update';
export const SCAN_ACTION_COMPLETE = 'complete';

const DEFAULT_BATCH_SIZE = 30;
const DEFAULT_PAUSE_MS = 100;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_DEBOUNCE_MS = 5000;

type FileWatcher = {
  on: (event: string, cb: (filePath: string) => void) => FileWatcher;
  close?: () => Promise<void> | void;
};

type FileProcessingState = {
  watcher: FileWatcher;
  /** Project root (absolute); used for processingRelative in scan metrics. */
  rootDir: string;
  queue: string[];
  queued: Set<string>;
  knownFiles: Set<string>;
  checksumMap: Map<string, string>;
  total: number;
  processedCount: number;
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  batchSize: number;
  pauseMs: number;
  concurrency: number;
  debounceMs: number;
};

const watcherByProject = new Map<string, FileProcessingState>();
const fileProcessingStartupInflight = new Map<string, Promise<void>>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toProcessingRelative(rootDir: string, paths: string[]): string[] {
  return paths.map((p) => path.relative(rootDir, p).split(path.sep).join('/'));
}

async function postScanMetric(params: {
  projectKey: string;
  action: string;
  total: number;
  processedCount: number;
  processing?: string[];
  processingRelative?: string[];
}): Promise<void> {
  const ts = new Date().toISOString();
  await postMetric({
    instance_id: INSTANCE_ID,
    operation: SCAN_METRIC_KEY,
    kind: 'event',
    started_at: ts,
    ended_at: ts,
    duration_ms: 0,
    status: 'ok',
    metadata: {
      projectKey: params.projectKey,
      action: params.action,
      total: params.total,
      processedCount: params.processedCount,
      processing: params.processing ?? [],
      processingRelative: params.processingRelative ?? [],
      ts
    }
  });
}

function enqueue(state: FileProcessingState, filePath: string, priority: boolean): void {
  if (shouldIgnore(filePath, state.rootDir)) return;
  if (state.queued.has(filePath)) return;
  state.queued.add(filePath);
  if (priority) state.queue.unshift(filePath);
  else state.queue.push(filePath);
}

async function processQueue(projectKey: string): Promise<void> {
  const state = watcherByProject.get(projectKey);
  if (!state || state.running) return;
  state.running = true;
  const { batchSize, pauseMs, concurrency, rootDir } = state;
  const limit = pLimit(Math.max(1, concurrency));
  try {
    while (state.queue.length > 0) {
      const batch = state.queue.splice(0, batchSize);
      batch.forEach((p) => state.queued.delete(p));

      await postScanMetric({
        projectKey,
        action: SCAN_ACTION_UPDATE,
        total: state.total,
        processedCount: state.processedCount,
        processing: batch,
        processingRelative: toProcessingRelative(rootDir, batch)
      });

      const counts = await Promise.all(
          batch.map((filePath) =>
            limit(async (): Promise<number> => {
              try {
                const checksum = calculateMD5(filePath);
                const existingChecksum = state.checksumMap.get(filePath);
                if (existingChecksum === checksum) return 0;
                await runFileProcessingLlm({
                  projectKey,
                  filePath,
                  rootDir,
                  caller: MODEL_CALL_CALLER_FILE_PROCESSING
                });
                return 1;
              } catch {
                return 0;
              }
            })
          )
        );
      const readInBatch = counts.reduce((a, b) => a + b, 0);

      state.processedCount += readInBatch;

      if (readInBatch > 0) {
        const fts = new Date().toISOString();
        await postMetric({
          instance_id: INSTANCE_ID,
          operation: METRIC_OPERATION_READ,
          kind: 'event',
          started_at: fts,
          ended_at: fts,
          duration_ms: 0,
          status: 'ok',
          metadata: { entries: [{ projectKey, count: readInBatch }] }
        });
      }

      await postScanMetric({
        projectKey,
        action: SCAN_ACTION_UPDATE,
        total: state.total,
        processedCount: state.processedCount
      });

      if (state.queue.length > 0 && pauseMs > 0) await delay(pauseMs);
    }
    await postScanMetric({
      projectKey,
      action: SCAN_ACTION_COMPLETE,
      total: state.total,
      processedCount: state.processedCount
    });
  } finally {
    state.running = false;
  }
}

function scheduleProcess(projectKey: string): void {
  const state = watcherByProject.get(projectKey);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  const ms = Math.max(0, state.debounceMs);
  state.timer = setTimeout(() => {
    state.timer = null;
    void processQueue(projectKey);
  }, ms);
}

/**
 * Runs on MCP client startup. Schedules initial processing and starts a watcher.
 * For now this does not write FileProcessor/knowledge_base; it only reports scan metrics.
 */
export async function runFileProcessingStartup(projectKey: string): Promise<void> {
  if (watcherByProject.has(projectKey)) return;
  let inflight = fileProcessingStartupInflight.get(projectKey);
  if (!inflight) {
    inflight = runFileProcessingStartupBody(projectKey).finally(() => {
      fileProcessingStartupInflight.delete(projectKey);
    });
    fileProcessingStartupInflight.set(projectKey, inflight);
  }
  await inflight;
}

async function runFileProcessingStartupBody(projectKey: string): Promise<void> {
  if (watcherByProject.has(projectKey)) return;

  const project = await Project.findOne({ key: projectKey }).lean().exec();
  const batchSize = Math.max(1, project?.file_processing_batch_size ?? DEFAULT_BATCH_SIZE);
  const pauseMs = Math.max(0, project?.file_processing_pause_ms ?? DEFAULT_PAUSE_MS);
  const concurrency = Math.max(1, project?.file_processing_concurrency ?? DEFAULT_CONCURRENCY);
  const debounceMs = Math.max(0, project?.file_processing_debounce_ms ?? DEFAULT_DEBOUNCE_MS);

  const dir = await getProjectRoot(projectKey);
  logFileWatchIgnoreSummary(dir);
  const allPaths = listFilesUnderRoot(dir);
  const checksumMap = await getFileProcessorChecksumMap(projectKey);
  const knownFiles = new Set(allPaths);

  const chokidarModule = await import('chokidar');
  const watcher = chokidarModule.default.watch(dir, {
    ignoreInitial: true,
    ignored: createChokidarIgnored(dir)
  });
  const state: FileProcessingState = {
    watcher: watcher as unknown as FileWatcher,
    rootDir: dir,
    queue: [],
    queued: new Set<string>(),
    knownFiles,
    checksumMap,
    total: allPaths.length,
    processedCount: 0,
    running: false,
    timer: null,
    batchSize,
    pauseMs,
    concurrency,
    debounceMs
  };
  watcherByProject.set(projectKey, state);

  await postScanMetric({
    projectKey,
    action: SCAN_ACTION_START,
    total: state.total,
    processedCount: state.processedCount
  });

  allPaths.forEach((p) => enqueue(state, p, false));
  scheduleProcess(projectKey);

  const onIncomingFile = (filePath: string): void => {
    if (shouldIgnore(filePath, state.rootDir)) return;
    if (!state.knownFiles.has(filePath)) {
      state.knownFiles.add(filePath);
      state.total += 1;
    }
    enqueue(state, filePath, true);
    scheduleProcess(projectKey);
  };

  watcher.on('add', onIncomingFile);
  watcher.on('change', onIncomingFile);
}

/** For tests and shutdown hooks. */
export async function stopFileProcessingWatcher(projectKey: string): Promise<void> {
  const state = watcherByProject.get(projectKey);
  if (!state) return;
  watcherByProject.delete(projectKey);
  if (state.timer) clearTimeout(state.timer);
  if (state.watcher.close) await state.watcher.close();
}

/** Test helper. */
export function resetFileProcessingStartupForTesting(): void {
  fileProcessingStartupInflight.clear();
  for (const key of watcherByProject.keys()) {
    void stopFileProcessingWatcher(key);
  }
}
