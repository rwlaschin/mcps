import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IAgentTools {
  file_watch: boolean;
  db_read_write: boolean;
  web_search: boolean;
  run_shell: boolean;
}

export interface IAgent extends Document {
  name: string;
  description: string;
  system_prompt: string;
  /** MCP tool id for this agent (must be unique per project; SEP-style identifier). */
  tool_name: string;
  /**
   * Saved-model category filter. Empty = agent may use any model.
   * Non-empty = model must have at least one matching tag in `LLMModel.categories`.
   */
  model_categories: string[];
  project_id: Types.ObjectId;
  persona_ids: Types.ObjectId[];
  /**
   * Optional vault-wide prompt (Config → Prompts → Global) to run first when executing this agent:
   * prep step on user/task context, then agent system prompt + personas consume that output.
   */
  global_prompt_id?: Types.ObjectId | null;
  tools: IAgentTools;
  save_to_seed: boolean;
  /** Seed file + restore baseline: SystemPrompt.slug */
  seed_baseline_global_prompt_slug?: string;
  seed_baseline_description?: string;
  seed_baseline_system_prompt?: string;
  seed_baseline_tool_name?: string;
  seed_baseline_model_categories?: string[];
  seed_baseline_persona_names?: string[];
  seed_baseline_tools?: IAgentTools;
  /** @deprecated Prefer `model_categories`; may exist on old documents. */
  model_category?: string;
  /** @deprecated Prefer `model_categories`; may exist on old documents. */
  model_ids?: Types.ObjectId[];
  seed_baseline_model_names?: string[];
  seed_baseline_model_category?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AgentToolsSchema = new Schema<IAgentTools>(
  {
    file_watch: { type: Boolean, default: false },
    db_read_write: { type: Boolean, default: false },
    web_search: { type: Boolean, default: false },
    run_shell: { type: Boolean, default: false }
  },
  { _id: false }
);

const AgentSchema = new Schema<IAgent>(
  {
    name: { type: String, required: true },
    description: { type: String, required: true },
    system_prompt: { type: String, required: true },
    tool_name: { type: String, required: true },
    model_categories: [{ type: String }],
    project_id: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    persona_ids: [{ type: Schema.Types.ObjectId, ref: 'Persona' }],
    global_prompt_id: { type: Schema.Types.ObjectId, ref: 'SystemPrompt', default: null },
    tools: { type: AgentToolsSchema, default: () => ({}) },
    save_to_seed: { type: Boolean, default: false },
    seed_baseline_description: { type: String, required: false },
    seed_baseline_system_prompt: { type: String, required: false },
    seed_baseline_tool_name: { type: String, required: false },
    seed_baseline_model_categories: [{ type: String }],
    seed_baseline_persona_names: [{ type: String }],
    seed_baseline_global_prompt_slug: { type: String, required: false },
    seed_baseline_tools: { type: AgentToolsSchema, required: false },
    /** @deprecated Removed from API; dropped on save. */
    model_category: { type: String, required: false },
    /** @deprecated Replaced by model_categories; dropped on save. */
    model_ids: [{ type: Schema.Types.ObjectId, ref: 'LLMModel' }],
    seed_baseline_model_names: [{ type: String }],
    seed_baseline_model_category: { type: String, required: false }
  },
  { timestamps: true }
);

AgentSchema.index({ project_id: 1 });
AgentSchema.index({ project_id: 1, name: 1 });
/** One MCP tool id per project (matches server validation). */
AgentSchema.index({ project_id: 1, tool_name: 1 }, { unique: true });

export const Agent =
  mongoose.models?.Agent ?? mongoose.model<IAgent>('Agent', AgentSchema);
