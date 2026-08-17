// MD5 Calculation

import * as fs from 'fs';
import * as crypto from 'crypto';

export function calculateMD5(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(data).digest('hex');
}
