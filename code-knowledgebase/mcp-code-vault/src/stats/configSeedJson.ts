import * as fs from 'fs';
import * as path from 'path';

const SEED_DIR = path.join(process.cwd(), 'configs', 'seed');
const PERSONAS_SEED = path.join(SEED_DIR, 'personas.json');
const AGENTS_SEED = path.join(SEED_DIR, 'agents.json');

export type PersonaSeedRow = { name: string; description: string; prompt: string };

export type AgentToolsSeed = {
  file_watch?: boolean;
  db_read_write?: boolean;
  web_search?: boolean;
  run_shell?: boolean;
};

export type AgentSeedRow = {
  name: string;
  description: string;
  system_prompt: string;
  tool_name: string;
  project_key: string;
  /** Empty or omitted = all model categories; otherwise agent is limited to these tags. */
  model_categories?: string[];
  persona_names: string[];
  tools: AgentToolsSeed;
  /** Optional Config → Prompts → Global slug (`SystemPrompt.slug`). */
  global_prompt_slug?: string;
};

function ensureSeedDir(): void {
  if (!fs.existsSync(SEED_DIR)) fs.mkdirSync(SEED_DIR, { recursive: true });
}

export function readPersonaSeedRows(): PersonaSeedRow[] {
  if (!fs.existsSync(PERSONAS_SEED)) return [];
  try {
    const raw = fs.readFileSync(PERSONAS_SEED, 'utf-8');
    const parsed = JSON.parse(raw) as PersonaSeedRow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writePersonaSeedRows(rows: PersonaSeedRow[]): void {
  ensureSeedDir();
  fs.writeFileSync(PERSONAS_SEED, JSON.stringify(rows, null, 2), 'utf-8');
}

export function readAgentSeedRows(): AgentSeedRow[] {
  if (!fs.existsSync(AGENTS_SEED)) return [];
  try {
    const raw = fs.readFileSync(AGENTS_SEED, 'utf-8');
    const parsed = JSON.parse(raw) as AgentSeedRow[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeAgentSeedRows(rows: AgentSeedRow[]): void {
  ensureSeedDir();
  fs.writeFileSync(AGENTS_SEED, JSON.stringify(rows, null, 2), 'utf-8');
}
