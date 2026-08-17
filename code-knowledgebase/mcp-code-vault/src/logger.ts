import * as fs from 'fs';
import { Writable } from 'stream';
import pino from 'pino';
import { ensureLogDir, getLogPath } from './logFile';

const isTest = process.env.NODE_ENV === 'test';
const logLevel = isTest ? 'silent' : (process.env.LOG_LEVEL ?? 'info');

const noopStream = new Writable({ write(_chunk, _enc, cb) { cb(); } });

/**
 * Use pino.destination with fd from fs.openSync so the stream is ready immediately.
 * Avoids "sonic boom is not ready yet" on process exit (see https://github.com/pinojs/pino/issues/871).
 */
function getDestination(): pino.DestinationStream {
  if (isTest) return noopStream as pino.DestinationStream;
  ensureLogDir();
  const path = getLogPath();
  const fd = fs.openSync(path, 'a');
  return pino.destination({ fd, sync: false });
}

export const logger = pino(
  {
    level: logLevel,
    timestamp: pino.stdTimeFunctions.isoTime
  },
  getDestination()
);
