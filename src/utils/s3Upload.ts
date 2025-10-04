import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  PutObjectCommandInput,
  DeleteObjectCommandInput,
  HeadObjectCommand,
  ObjectCannedACL,
} from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";
import config from "../config.js";

// Interface for the file object expected by uploadFile
export interface UploadableFile {
  originalname: string;
  buffer: Buffer;
  mimetype: string;
  size: number;
}

// Interface for the return type of uploadFile
export interface UploadResult {
  url: string;
  key: string;
  etag?: string;
}

export interface FileMetadata {
  key: string;
  size: number;
  mimetype: string;
  lastModified?: Date;
  etag?: string;
}

// Initialize S3 client only if S3 is configured
const s3Client = config.s3
  ? new S3Client({
      region: config.s3.region,
      endpoint: config.s3.endpoint,
      credentials: {
        accessKeyId: config.s3.accessKeyId,
        secretAccessKey: config.s3.secretAccessKey,
      },
      forcePathStyle: !!config.s3.endpoint, // Use path style for custom endpoints
    })
  : null;

/**
 * Validates S3 configuration
 */
export const validateS3Config = (): void => {
  if (!config.s3) {
    throw new Error("S3 is not configured");
  }
  if (!config.s3.bucketName) {
    throw new Error("S3 bucket name is not configured");
  }
  if (!config.s3.accessKeyId || !config.s3.secretAccessKey) {
    throw new Error("S3 credentials are not configured");
  }
};

/**
 * Uploads a file to S3
 */
export const uploadFile = async (
  file: UploadableFile,
  options: {
    folder?: string;
    acl?: string;
    metadata?: Record<string, string>;
  } = {}
): Promise<UploadResult> => {
  validateS3Config();

  const fileExtension = file.originalname.split(".").pop() || "bin";
  const fileName = `${uuidv4()}.${fileExtension}`;
  const key = options.folder ? `${options.folder}/${fileName}` : fileName;

  const params: PutObjectCommandInput = {
    Bucket: config.s3!.bucketName,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
    ContentLength: file.size,
    ACL: options.acl ? (options.acl as ObjectCannedACL) : "public-read",
    Metadata: options.metadata,
  };

  try {
    const result = await s3Client!.send(new PutObjectCommand(params));

    let url: string;
    if (config.s3!.endpoint) {
      // For custom endpoints (MinIO, DigitalOcean Spaces, etc.)
      url = `${config.s3!.endpoint}/${config.s3!.bucketName}/${key}`;
    } else {
      // For AWS S3
      url = `https://${config.s3!.bucketName}.s3.${
        config.s3!.region
      }.amazonaws.com/${key}`;
    }

    return { url, key, etag: result.ETag };
  } catch (error) {
    throw new Error(
      `Failed to upload file to S3: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};

/**
 * Deletes a file from S3
 */
export const deleteFile = async (key: string): Promise<void> => {
  validateS3Config();

  const params: DeleteObjectCommandInput = {
    Bucket: config.s3!.bucketName,
    Key: key,
  };

  try {
    await s3Client!.send(new DeleteObjectCommand(params));
  } catch (error) {
    throw new Error(
      `Failed to delete file from S3: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};

/**
 * Gets file metadata from S3
 */
export const getFileMetadata = async (key: string): Promise<FileMetadata> => {
  validateS3Config();

  const params = {
    Bucket: config.s3!.bucketName,
    Key: key,
  };

  try {
    const result = await s3Client!.send(new HeadObjectCommand(params));
    return {
      key,
      size: result.ContentLength || 0,
      mimetype: result.ContentType || "application/octet-stream",
      lastModified: result.LastModified,
      etag: result.ETag,
    };
  } catch (error) {
    throw new Error(
      `Failed to get file metadata: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};

/**
 * Extracts S3 key from URL
 */
export const extractS3Key = (url: string | undefined): string | undefined => {
  if (!url || !config.s3) return undefined;

  try {
    // Handle custom endpoints
    if (config.s3.endpoint && url.includes(config.s3.endpoint)) {
      return url.replace(`${config.s3.endpoint}/${config.s3.bucketName}/`, "");
    }

    // Handle AWS S3 URLs
    if (url.includes("amazonaws.com")) {
      const urlObj = new URL(url);
      return urlObj.pathname.slice(1);
    }

    // Generic URL parsing
    const urlObj = new URL(url);
    return urlObj.pathname.slice(1);
  } catch {
    // Fallback: extract the last part of the URL after bucket name
    if (url.includes(config.s3.bucketName)) {
      const parts = url.split(config.s3.bucketName);
      return parts[1]?.replace(/^\//, "").split("?")[0];
    }
    return url.split("/").pop()?.split("?")[0];
  }
};

/**
 * Validates if a file exists in S3
 */
export const fileExists = async (key: string): Promise<boolean> => {
  try {
    await getFileMetadata(key);
    return true;
  } catch {
    return false;
  }
};

/**
 * Check if S3 is configured
 */
export const isS3Configured = (): boolean => {
  return !!config.s3;
};
