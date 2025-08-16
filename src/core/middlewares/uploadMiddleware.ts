import multer, { Field, FileFilterCallback } from "multer";
import { Request, Response, NextFunction } from "express";
import { uploadFile } from "../../utils/s3Upload.js";

interface UploadedFiles {
  [fieldname: string]: Express.Multer.File[];
}

interface UploadedFilesResult {
  [fieldname: string]: string; // URL
  [fieldnameKey: `${string}Key`]: string; // Key for cleanup
}

interface RequestWithFiles extends Request {
  files?: UploadedFiles | Express.Multer.File[];
  uploadedFiles?: UploadedFilesResult;
}

export const handleMultipleFiles = (fileFields: string[]) => {
  const fields: Field[] = fileFields.map((field) => ({
    name: field,
    maxCount: 1,
  }));

  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB/file
    fileFilter: (
      req: Request,
      file: Express.Multer.File,
      cb: FileFilterCallback
    ) => {
      cb(null, true);
    },
  }).fields(fields);
};

export const processFileUploads = async (
  req: RequestWithFiles,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (!req.files) return next();

  try {
    req.uploadedFiles = {};

    const filesToProcess = Array.isArray(req.files)
      ? { files: req.files }
      : req.files;

    for (const [field, files] of Object.entries(filesToProcess)) {
      if (files?.[0]) {
        const { url, key } = await uploadFile(files[0]);
        req.uploadedFiles[field] = url;
        req.uploadedFiles[`${field}Key` as const] = key;
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

export const extractS3Key = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    const urlObj = new URL(url);
    return urlObj.pathname.slice(1);
  } catch {
    return url.split("/").pop();
  }
};
