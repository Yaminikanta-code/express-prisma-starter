import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  PutObjectCommandInput,
  DeleteObjectCommandInput,
} from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";
import config from "../config";

// Interface for the file object expected by uploadFile
interface UploadableFile {
  originalname: string;
  buffer: Buffer;
  mimetype: string;
}

// Interface for the return type of uploadFile
interface UploadResult {
  url: string;
  key: string;
}

// Initialize S3 client with proper typing
const s3Client = new S3Client({
  region: config.s3?.region,
  endpoint: config.s3?.endpoint,
  credentials: {
    accessKeyId: config.s3?.accessKeyId ?? "",
    secretAccessKey: config.s3?.secretAccessKey ?? "",
  },
  forcePathStyle: true,
});

/**
 * Uploads a file to S3
 * @param file The file to upload
 * @returns Promise containing the URL and key of the uploaded file
 * @throws Error if S3 configuration is incomplete or upload fails
 */
export const uploadFile = async (
  file: UploadableFile
): Promise<UploadResult> => {
  if (!config.s3?.bucketName) {
    throw new Error("S3 bucket name is not configured");
  }

  const key = `${uuidv4()}-${file.originalname}`;
  const params: PutObjectCommandInput = {
    Bucket: config.s3.bucketName,
    Key: key,
    Body: file.buffer,
    ContentType: file.mimetype,
  };

  try {
    await s3Client.send(new PutObjectCommand(params));

    const endpoint = config.s3.endpoint
      ? config.s3.endpoint.replace(/^https?:\/\//, "") // Remove protocol if present
      : `s3.${config.s3.region}.amazonaws.com`;

    return {
      url: `https://${config.s3.bucketName}.${endpoint}/${key}`,
      key,
    };
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
 * @param key The key of the file to delete
 * @throws Error if S3 configuration is incomplete or deletion fails
 */
export const deleteFile = async (key: string): Promise<void> => {
  if (!config.s3?.bucketName) {
    throw new Error("S3 bucket name is not configured");
  }

  const params: DeleteObjectCommandInput = {
    Bucket: config.s3.bucketName,
    Key: key,
  };

  try {
    await s3Client.send(new DeleteObjectCommand(params));
  } catch (error) {
    throw new Error(
      `Failed to delete file from S3: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
};
