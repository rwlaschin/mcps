import mongoose, { Schema, Document, Types } from 'mongoose';

export interface ISymbol extends Document {
  project_id: Types.ObjectId;
  file: string;
  summary: string;
  updated: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const SymbolSchema = new Schema<ISymbol>(
  {
    project_id: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    file: { type: String, required: true },
    summary: { type: String, required: true },
    updated: { type: Date, required: true }
  },
  { timestamps: true }
);

SymbolSchema.index({ project_id: 1, file: 1 }, { unique: true });
SymbolSchema.index({ project_id: 1, updated: -1 });

export const Symbol =
  mongoose.models?.Symbol ?? mongoose.model<ISymbol>('Symbol', SymbolSchema);
