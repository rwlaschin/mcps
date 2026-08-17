import mongoose, { Schema, Document } from 'mongoose';

export interface IMetric extends Document {
  instance_id: string;
  operation: string;
  kind: 'query' | 'event';
  started_at: Date;
  ended_at: Date;
  duration_ms: number;
  status: 'ok' | 'error';
  error_code?: string;
  metadata?: Record<string, unknown>;
}

const MetricSchema = new Schema<IMetric>(
  {
    instance_id: { type: String, required: true },
    operation: { type: String, required: true },
    kind: { type: String, enum: ['query', 'event'], required: true },
    started_at: { type: Date, required: true },
    ended_at: { type: Date, required: true },
    duration_ms: { type: Number, required: true },
    status: { type: String, enum: ['ok', 'error'], required: true },
    error_code: { type: String },
    metadata: { type: Schema.Types.Mixed, default: () => ({}) }
  },
  { timestamps: true }
);

MetricSchema.index({ instance_id: 1, started_at: -1 });
MetricSchema.index({ operation: 1, started_at: -1 });

export const Metric = mongoose.models?.Metric ?? mongoose.model<IMetric>('Metric', MetricSchema);
