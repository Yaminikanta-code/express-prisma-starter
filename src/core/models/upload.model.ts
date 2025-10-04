import { FileMetadata } from "@/utils/s3Upload.js";

export interface UploadConfig {
  maxFileSize: number;
  allowedMimeTypes: string[];
  maxFiles: number;
}

export interface UploadResult {
  success: boolean;
  originalName: string;
  url?: string;
  key?: string;
  mimetype?: string;
  size?: number;
  error?: string;
}

export interface UploadResponse {
  success: boolean;
  message: string;
  data?:
    | {
        url?: string;
        key?: string;
        originalName?: string;
        mimetype?: string;
        size?: number;
        uploadedAt?: string;
        exists?: boolean;
      }
    | FileMetadata;
  results?: UploadResult[];
  total?: number;
  successful?: number;
  failed?: number;
}
