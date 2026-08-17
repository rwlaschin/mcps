import mongoose, { Document, Schema } from 'mongoose';

/** Vault-wide system prompts. MongoDB collection name: `prompts`. */

export type PromptType = 'processing' | 'agent';
export type PromptCategory = 'fast' | 'blended' | 'thinking';

/** Any prompt may declare structured output (preset + MIME) for consumers that validate or parse it. */
export type PromptStructureMode = 'unstructured' | 'structured';
export type PromptStructureMime = 'application/json' | 'application/x-yaml-extended';

/** Legacy bucket for integrations that still branch on processing vs agent. */
export function derivePromptTypeFromUsageType(usageType: string): PromptType {
  const u = String(usageType ?? '').trim().toLowerCase();
  if (u === 'user request' || u === 'platform assistant') return 'agent';
  return 'processing';
}

export function deriveUsageTypeFromPromptType(promptType: string): string {
  return promptType === 'agent' ? 'user request' : 'file processor';
}

export interface ISystemPrompt extends Document {
  name: string;
  slug: string;
  prompt: string;
  /** User-defined role, e.g. "file processor", "user request" (one default per usage_type). */
  usage_type: string;
  /**
   * @deprecated Derive from usage_type; kept for backward compatibility and lean queries.
   */
  prompt_type?: PromptType;
  category: PromptCategory;
  is_default: boolean;
  save_to_seed: boolean;
  seed_baseline_prompt?: string;
  /** When structured, UI/backend know expected shape (e.g. agent pipeline step array). */
  structure_mode: PromptStructureMode;
  structure_preset: string;
  structure_mime: PromptStructureMime;
  createdAt: Date;
  updatedAt: Date;
}

const SystemPromptSchema = new Schema<ISystemPrompt>(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    prompt: { type: String, required: true },
    usage_type: { type: String, required: true, trim: true },
    prompt_type: { type: String, enum: ['processing', 'agent'], required: false },
    category: { type: String, enum: ['fast', 'blended', 'thinking'], required: true },
    is_default: { type: Boolean, default: false },
    save_to_seed: { type: Boolean, default: false },
    seed_baseline_prompt: { type: String, required: false },
    structure_mode: {
      type: String,
      enum: ['unstructured', 'structured'],
      default: 'unstructured'
    },
    structure_preset: { type: String, default: 'agent_pipeline_steps' },
    structure_mime: {
      type: String,
      enum: ['application/json', 'application/x-yaml-extended'],
      default: 'application/json'
    }
  },
  { timestamps: true, collection: 'prompts' }
);

SystemPromptSchema.pre('validate', async function () {
  const doc = this as mongoose.Document & { usage_type?: string; prompt_type?: string | undefined };
  let ut = String(doc.usage_type ?? '').trim();
  const pt = doc.prompt_type;
  if (!ut && (pt === 'processing' || pt === 'agent')) {
    ut = deriveUsageTypeFromPromptType(pt);
    doc.usage_type = ut;
  }
  if (!ut) {
    throw new Error('usage_type is required');
  }
  if (pt !== 'processing' && pt !== 'agent') {
    doc.prompt_type = derivePromptTypeFromUsageType(ut);
  }
});

SystemPromptSchema.index({ usage_type: 1, is_default: 1 });
SystemPromptSchema.index({ usage_type: 1, category: 1 });

export const SystemPrompt =
  mongoose.models?.SystemPrompt ?? mongoose.model<ISystemPrompt>('SystemPrompt', SystemPromptSchema);
