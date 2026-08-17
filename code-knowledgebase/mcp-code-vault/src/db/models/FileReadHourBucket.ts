import mongoose, { Schema, Document } from 'mongoose';

/** Per-project file-read counts for one local calendar hour (key format yyyy/MM/dd HH). */
export interface IFileReadHourBucket extends Document {
  projectKey: string;
  hourKey: string;
  count: number;
}

const FileReadHourBucketSchema = new Schema<IFileReadHourBucket>(
  {
    projectKey: { type: String, required: true },
    hourKey: { type: String, required: true },
    count: { type: Number, default: 0 }
  },
  { timestamps: true }
);

FileReadHourBucketSchema.index({ projectKey: 1, hourKey: 1 }, { unique: true });

export const FileReadHourBucket =
  mongoose.models?.FileReadHourBucket ??
  mongoose.model<IFileReadHourBucket>('FileReadHourBucket', FileReadHourBucketSchema);
