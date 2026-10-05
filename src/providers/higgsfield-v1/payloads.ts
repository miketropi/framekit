import { z } from "zod";
import { ToolError } from "../../domain/errors";

/**
 * V1 wire payloads. Parsed once at the network boundary so no unvalidated
 * provider shape reaches the domain.
 */

const resultSchema = z.object({
  url: z.string().min(1),
  type: z.string().optional(),
});

export const jobSchema = z.object({
  id: z.string().min(1),
  status: z.string().min(1),
  results: z.record(z.string(), resultSchema).nullish(),
});

export const jobSetSchema = z.object({
  id: z.string().min(1),
  jobs: z.array(jobSchema),
});

export const jobListSchema = z.object({
  jobs: z.array(jobSchema),
});

export const motionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  preview_url: z.string().optional(),
  start_end_frame: z.boolean().optional(),
});

export const styleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  preview_url: z.string().optional(),
});

export const motionListSchema = z.array(motionSchema);

export const styleListSchema = z.array(styleSchema);

export const soulIdSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.string().min(1),
});

export const soulIdPageSchema = z.object({
  total: z.number(),
  page: z.number(),
  page_size: z.number(),
  total_pages: z.number(),
  items: z.array(soulIdSchema),
});

export type V1Job = z.infer<typeof jobSchema>;
export type V1Motion = z.infer<typeof motionSchema>;
export type V1Style = z.infer<typeof styleSchema>;
export type V1SoulId = z.infer<typeof soulIdSchema>;

export function parsePayload<T extends z.ZodType>(
  schema: T,
  raw: unknown,
  what: string,
): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new ToolError({
    code: "UNKNOWN_PROVIDER_ERROR",
    message: `Higgsfield returned an unexpected ${what} payload.`,
    details: {
      what,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    },
  });
}
