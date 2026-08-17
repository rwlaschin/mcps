/**
 * Resolves ignore rules from .gitignore and other .*ignore files (same semantics as git:
 * patterns are relative to the directory containing each ignore file). Parent directories
 * are chained root-to-leaf so negations behave like git.
 *
 * Built-in: always treat `.git/` and `node_modules/` as ignored (even with no ignore files).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Stats } from 'fs';
import ignore from 'ignore';
import { writeProcessLog } from '../stdioMode';

const BUILTIN_IGNORE_LINES = ['.git/', 'node_modules/', '.DS_Store'];

/** Test hook: clear memoized ignore instances. */
const mergerCache = new Map<string, ReturnType<typeof ignore>>();

export function clearIgnoreMergerCacheForTesting(): void {
  mergerCache.clear();
}

function isIgnoreBasename(name: string): boolean {
  return name.startsWith('.') && name.endsWith('ignore') && name.length > 'ignore'.length + 1;
}

function readIgnorePatternsFromDir(absDir: string): string {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return '';
  }
  const names = entries
    .filter((e) => e.isFile() && isIgnoreBasename(e.name))
    .map((e) => e.name)
    .sort();
  let blob = '';
  for (const name of names) {
    const filePath = path.join(absDir, name);
    try {
      blob += fs.readFileSync(filePath, 'utf8') + '\n';
    } catch {
      // unreadable — skip
    }
  }
  return blob;
}

/**
 * Parent prefixes from repo root down to and including `parentRelPosix`
 * (e.g. pkg/sub/file -> chain '', 'pkg', 'pkg/sub' for parent pkg/sub).
 */
function parentPrefixChain(parentRelPosix: string): string[] {
  const chain: string[] = [''];
  if (!parentRelPosix || parentRelPosix === '.') return chain;
  const parts = parentRelPosix.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    chain.push(parts.slice(0, i + 1).join('/'));
  }
  return chain;
}

function loadMergedPatterns(projectRoot: string, parentRelPosix: string): string {
  const resolvedRoot = path.resolve(projectRoot);
  let blob = `${BUILTIN_IGNORE_LINES.join('\n')}\n`;
  for (const pr of parentPrefixChain(parentRelPosix)) {
    const absDir = pr ? path.normalize(path.join(resolvedRoot, ...pr.split('/'))) : resolvedRoot;
    blob += readIgnorePatternsFromDir(absDir);
  }
  return blob;
}

function mergerCacheKey(projectRoot: string, parentRelPosix: string): string {
  return `${path.resolve(projectRoot)}\0${parentRelPosix}`;
}

function getMerger(projectRoot: string, parentRelPosix: string): ReturnType<typeof ignore> {
  const key = mergerCacheKey(projectRoot, parentRelPosix);
  let ig = mergerCache.get(key);
  if (!ig) {
    ig = ignore().add(loadMergedPatterns(projectRoot, parentRelPosix));
    mergerCache.set(key, ig);
  }
  return ig;
}

/** First-line summary of ignore rules for file watching (built-ins, root *ignore files, pattern count). */
export function logFileWatchIgnoreSummary(projectRoot: string): void {
  const root = path.resolve(projectRoot);
  let ignoreFilenames: string[] = [];
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    ignoreFilenames = entries
      .filter((e) => e.isFile() && isIgnoreBasename(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    ignoreFilenames = [];
  }
  const blob = loadMergedPatterns(root, '');
  const patternLines = blob
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#')).length;

  const ignoreFilesLabel = ignoreFilenames.length
    ? ignoreFilenames.join(', ')
    : '(none — built-ins only)';
  writeProcessLog(
    `[file-watch] ignore summary: projectRoot=${root}; built-ins=${BUILTIN_IGNORE_LINES.join(', ')}; ` +
      `ignore files at root=${ignoreFilesLabel}; merged pattern lines=${patternLines}\n`
  );
}

const CHOKIDAR_IGNORE_LOG_SAMPLES = 5;

/**
 * @param absPath Absolute or project-relative path (resolved against projectRoot if relative)
 * @param projectRoot Absolute project root
 * @param isDirectory When true, path is checked as a directory (trailing slash for gitignore)
 */
export function shouldIgnore(absPath: string, projectRoot: string, isDirectory = false): boolean {
  const root = path.resolve(projectRoot);
  const abs = path.isAbsolute(absPath) ? path.resolve(absPath) : path.resolve(root, absPath);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..')) {
    return true;
  }
  if (rel === '') {
    return false;
  }
  const posixRel = rel.split(path.sep).join('/');
  const parentRel = path.posix.dirname(posixRel);
  const parentKey = parentRel === '.' ? '' : parentRel;
  const ig = getMerger(root, parentKey);
  const checkPath =
    isDirectory && !posixRel.endsWith('/') ? `${posixRel}/` : posixRel;
  return ig.ignores(checkPath);
}

/**
 * Chokidar `ignored` callback: classify directories for `node-ignore` (`foo` vs `foo/`).
 * If chokidar omits `stats`, uses `lstatSync` so directory-only rules still apply.
 * Logs the first few invocations (path, stats source, ignored result) to the process log / MCP log file.
 */
export function createChokidarIgnored(
  projectRoot: string
): (path: string, stats?: Stats) => boolean {
  /** Chokidar may call `ignored()` multiple times for the same path; dedupe so stderr/UI is not doubled. */
  const sampleRowsSeen = new Set<string>();
  return (p: string, stats?: Stats): boolean => {
    let statsSource: 'chokidar' | 'lstat' | 'unstatable';
    let isDirectory: boolean;
    if (stats) {
      statsSource = 'chokidar';
      isDirectory = stats.isDirectory();
    } else {
      try {
        isDirectory = fs.lstatSync(p).isDirectory();
        statsSource = 'lstat';
      } catch {
        statsSource = 'unstatable';
        isDirectory = false;
      }
    }
    const ignored = shouldIgnore(p, projectRoot, isDirectory);
    if (sampleRowsSeen.size < CHOKIDAR_IGNORE_LOG_SAMPLES) {
      const dedupeKey = `${statsSource}\n${p}\n${isDirectory}\n${ignored}`;
      if (!sampleRowsSeen.has(dedupeKey)) {
        sampleRowsSeen.add(dedupeKey);
        writeProcessLog(
          `[file-watch] ignored() sample ${sampleRowsSeen.size}/${CHOKIDAR_IGNORE_LOG_SAMPLES}: path=${p} stats=${statsSource} isDirectory=${isDirectory} ignored=${ignored}\n`
        );
      }
    }
    return ignored;
  };
}
