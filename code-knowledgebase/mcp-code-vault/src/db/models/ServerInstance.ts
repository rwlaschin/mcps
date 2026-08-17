import mongoose, { Schema, Document } from 'mongoose';

export interface IServerInstance extends Document {
  started_at: Date;
  last_seen: Date;
  port: number;
  local_url: string;
  network_url?: string;
  log_path: string;
  pid: number;
}

const ServerInstanceSchema = new Schema<IServerInstance>(
  {
    started_at: { type: Date, required: true },
    last_seen: { type: Date, required: true },
    port: { type: Number, required: true },
    local_url: { type: String, required: true },
    network_url: { type: String },
    log_path: { type: String, required: true },
    pid: { type: Number, required: true }
  },
  { timestamps: true }
);

ServerInstanceSchema.index({ started_at: -1 });

export const ServerInstance =
  mongoose.models?.ServerInstance ??
  mongoose.model<IServerInstance>('ServerInstance', ServerInstanceSchema);
