import { z, ZodTypeAny } from "zod";

interface ValidationError {
  path: string;
  message: string;
  code: string;
}

export const validateWithZod = (schema: ZodTypeAny, data: unknown): any => {
  const result = schema.safeParse(data);
  if (!result.success) {
    const formattedErrors: ValidationError[] = result.error.issues.map(
      (issue) => ({
        path: issue.path.join("."),
        message: issue.message,
        code: issue.code,
      })
    );
    throw new Error(JSON.stringify(formattedErrors));
  }
  return result.data;
};
