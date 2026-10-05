import path from "node:path";
import { z } from "zod";
import { MANIFEST_SCHEMA_VERSION, type GenerationManifest } from "../domain/asset";
import { ASSET_KINDS, CAPABILITIES, GENERATION_STATUSES } from "../domain/generation";

/**
 * Manifest boundary schema. Any manifest read from disk — including one written
 * by an older build — is parsed here before it can influence a paid submission.
 */

const timestamp = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), "must be an ISO-8601 timestamp");

export const manifestSchema = z.object({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  assetId: z.string().min(1),
  provider: z.string().min(1),
  capability: z.enum(CAPABILITIES),
  logicalModel: z.string().min(1),
  fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  createdAt: timestamp,
  prompt: z.string().optional(),
  inputs: z.array(
    z.object({
      kind: z.enum(["image", "audio"]),
      localPath: z.string().min(1).optional(),
      url: z.string().min(1).optional(),
      sha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    }),
  ),
  request: z.record(z.string(), z.unknown()),
  remote: z.object({
    requestId: z.string().min(1),
    status: z.enum(GENERATION_STATUSES),
  }),
  outputs: z
    .array(
      z.object({
        type: z.enum(ASSET_KINDS),
        // Contained relative path: a manifest must never point outside its own
        // directory, or verification would hash and report unrelated files.
        path: z
          .string()
          .min(1)
          .refine((value) => !path.isAbsolute(value) && !value.includes("\0"), {
            message: "must be a relative path",
          })
          .refine(
            (value) => {
              const normalized = path.normalize(value);
              return (
                normalized !== ".." && !normalized.startsWith(`..${path.sep}`) && normalized !== "."
              );
            },
            { message: "must stay inside the output directory" },
          ),
        mimeType: z.string().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        bytes: z.number().int().positive(),
      }),
      "a completed manifest must declare at least one output",
    )
    .min(1, "a completed manifest must declare at least one output"),
});

export function parseManifest(value: unknown): GenerationManifest | undefined {
  const parsed = manifestSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
