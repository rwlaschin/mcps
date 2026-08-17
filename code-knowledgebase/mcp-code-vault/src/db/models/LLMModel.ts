import mongoose, { Schema, Document, Types } from 'mongoose';

export interface ILLMModel extends Document {
  name: string;
  provider: string;
  label: string;
  /** Tags for routing (fast, blended, thinking, plus custom strings e.g. Vision). At least one after normalize. */
  categories: string[];
  /** @deprecated Legacy single tier; migrated to `categories` in API responses. */
  category?: string;
  access_key?: string;
  /** Ref: `ModelProviderCredential` — multiple models can share one credential (same vendor, different model ids). */
  credential_id?: Types.ObjectId;
  /** For provider local: Ollama origin (e.g. http://127.0.0.1:11434) or OpenAI-compatible base (e.g. http://127.0.0.1:1234/v1). */
  api_base_url?: string;
  /** How to call the local server (Ollama native vs OpenAI-compatible chat). */
  local_api_mode?: 'ollama' | 'openai';
  priority?: number;
  enabled?: boolean;
  capabilities?: string[];
  is_custom?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const LLMModelSchema = new Schema<ILLMModel>(
  {
    name: { type: String, required: true },
    provider: { type: String, required: true },
    label: { type: String, required: true },
    categories: [{ type: String }],
    category: { type: String, required: false },
    access_key: { type: String, required: false },
    credential_id: { type: Schema.Types.ObjectId, ref: 'ModelProviderCredential', required: false },
    api_base_url: { type: String, required: false },
    local_api_mode: { type: String, enum: ['ollama', 'openai'], required: false },
    priority: { type: Number, required: false, default: 100 },
    enabled: { type: Boolean, required: false, default: true },
    capabilities: [{ type: String }],
    is_custom: { type: Boolean, required: false, default: false }
  },
  { timestamps: true, collection: 'models' }
);

LLMModelSchema.index({ provider: 1, name: 1, credential_id: 1 });

export const LLMModel =
  mongoose.models?.LLMModel ??
  mongoose.model<ILLMModel>('LLMModel', LLMModelSchema);
