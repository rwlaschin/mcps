import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IProject extends Document {
  name: string;
  key: string;
  /** Project root path (e.g. from MCP cwd). Resolved at runtime; single source of truth for scanner. */
  root_path?: string;
  default_model_id?: Types.ObjectId;
  /** File processing batch size (default 30). */
  file_processing_batch_size?: number;
  /** Pause in ms between batches (default 100). */
  file_processing_pause_ms?: number;
  /** Max concurrent in-flight file processing tasks per project (default 3). */
  file_processing_concurrency?: number;
  /** Watcher debounce before draining queue in ms (default 5000). */
  file_processing_debounce_ms?: number;
  /** SystemPrompt slug for file processor template (empty = use default prompt for usage_type "file processor"). */
  file_processing_prompt_slug?: string;
  /** Narrow LLM rotation to models in these categories (empty = all enabled). */
  file_processing_model_categories?: string[];
  /** When set, file indexing uses this agent's prompt stack and model tags instead of slug + project categories. */
  file_processing_agent_id?: Types.ObjectId | null;
  /** `prompt` = SystemPrompt slug + project model categories; `agent` = agent bundle (+ agent model tags). */
  file_processing_driver?: 'prompt' | 'agent';
  createdAt: Date;
  updatedAt: Date;
}

const ProjectSchema = new Schema<IProject>(
  {
    name: { type: String, required: true },
    key: { type: String, required: true, unique: true },
    root_path: { type: String, required: false },
    default_model_id: { type: Schema.Types.ObjectId, ref: 'LLMModel', default: null },
    file_processing_batch_size: { type: Number, required: false },
    file_processing_pause_ms: { type: Number, required: false },
    file_processing_concurrency: { type: Number, required: false },
    file_processing_debounce_ms: { type: Number, required: false },
    file_processing_prompt_slug: { type: String, required: false, trim: true },
    file_processing_model_categories: { type: [String], default: undefined },
    file_processing_agent_id: { type: Schema.Types.ObjectId, ref: 'Agent', default: null },
    file_processing_driver: {
      type: String,
      enum: ['prompt', 'agent'],
      default: 'prompt'
    }
  },
  { timestamps: true }
);

export const Project =
  mongoose.models?.Project ?? mongoose.model<IProject>('Project', ProjectSchema);
