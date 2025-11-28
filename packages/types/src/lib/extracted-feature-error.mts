import { z } from "zod";
import { ViewportSchema } from "./viewport.mjs";

const ErrorSchema = z.object({
    name: z.string(),
    message: z.string(),
    stack: z.string().optional(),
    cause: z.any().optional(),
});

export const ExtractedFeatureErrorSchema = z.object({
    url: z.string().url(),
    error: z.lazy(() => ErrorSchema),
    viewport: ViewportSchema,
});

export type ExtractedFeatureError = z.infer<typeof ExtractedFeatureErrorSchema>;

