import { z, ZodTypeAny, ZodObject, ZodSchema, ZodRawShape } from "zod";

/**
 * Creates a partial version of a Zod schema where all fields are optional
 * @param schema The original Zod schema to make partial
 * @returns A new Zod schema with all fields marked as optional
 */
export const createPartialZodSchema = <T extends ZodTypeAny>(
  schema: T
): T extends ZodObject<infer Shape extends ZodRawShape>
  ? ZodObject<{
      [K in keyof Shape]: Shape[K] extends ZodTypeAny
        ? ReturnType<Shape[K]["optional"]>
        : never;
    }>
  : T => {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape;
    const partialShape = Object.keys(shape).reduce((acc, key) => {
      const fieldSchema = shape[key];
      acc[key] = fieldSchema.optional();
      return acc;
    }, {} as Record<string, ZodTypeAny>);

    return z.object(partialShape) as any;
  }
  return schema as any;
};
