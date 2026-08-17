import mongoose, { Schema, Document } from 'mongoose';

export interface IPersona extends Document {
  name: string;
  description: string;
  prompt: string;
  save_to_seed: boolean;
  seed_baseline_name?: string;
  seed_baseline_description?: string;
  seed_baseline_prompt?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PersonaSchema = new Schema<IPersona>(
  {
    name: { type: String, required: true },
    description: { type: String, required: true },
    prompt: { type: String, required: true },
    save_to_seed: { type: Boolean, default: false },
    seed_baseline_name: { type: String, required: false },
    seed_baseline_description: { type: String, required: false },
    seed_baseline_prompt: { type: String, required: false }
  },
  { timestamps: true }
);

PersonaSchema.index({ name: 1 });

export const Persona =
  mongoose.models?.Persona ?? mongoose.model<IPersona>('Persona', PersonaSchema);
