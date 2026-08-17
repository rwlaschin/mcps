import mongoose, { Schema, Document } from 'mongoose';

/** One API account (key + optional base URL) shared by multiple saved models. */
export interface IModelProviderCredential extends Document {
  provider: string;
  access_key?: string;
  api_base_url?: string;
  local_api_mode?: 'ollama' | 'openai';
  createdAt: Date;
  updatedAt: Date;
}

const ModelProviderCredentialSchema = new Schema<IModelProviderCredential>(
  {
    provider: { type: String, required: true },
    access_key: { type: String, required: false },
    api_base_url: { type: String, required: false },
    local_api_mode: { type: String, enum: ['ollama', 'openai'], required: false }
  },
  { timestamps: true, collection: 'model_provider_credentials' }
);

ModelProviderCredentialSchema.index({ provider: 1 });

export const ModelProviderCredential =
  mongoose.models?.ModelProviderCredential ??
  mongoose.model<IModelProviderCredential>('ModelProviderCredential', ModelProviderCredentialSchema);
