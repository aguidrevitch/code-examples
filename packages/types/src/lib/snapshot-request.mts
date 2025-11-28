import { z } from "zod";
import { ViewportSchema } from "./viewport.mjs";
import { ImageFormatSchema } from "./image-formats.mjs";

export const SnapshotOptionsSchema = z.object({
    fullPage: z.boolean().default(true).optional(),
    format: ImageFormatSchema.optional(),
    quality: z.number().min(1).max(100).optional(),
    darkMode: z.boolean().optional(),
});

export const SnapshotRequestSchema = z.object({
    urls: z.string().url().array().min(1),
    viewports: ViewportSchema.strict().array(),
    // credentials is optional, it is going to be used for basic auth on the target URL
    credentials: z
        .object({
            name: z.string(),
            pass: z.string(),
        })
        .optional(),
    // any additional metadata that might be useful to be posted back
    metadata: z.record(z.any()).optional(),
    options: SnapshotOptionsSchema.optional(),
});

export type SnapshotOptions = z.infer<typeof SnapshotOptionsSchema>;
export type SnapshotRequest = z.infer<typeof SnapshotRequestSchema>;
