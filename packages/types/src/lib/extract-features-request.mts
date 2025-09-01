import { z } from "zod";
import { ViewportSchema } from "./viewport.mjs";

export const ExtractFeaturesRequestSchema = z.object({
    url: z.string().url(),
    viewports: ViewportSchema.array(),
    // credentials is optional, it is going to be used for basic auth on the target URL
    credentials: z
        .object({
            name: z.string(),
            pass: z.string(),
        })
        .optional(),
    // any additional metadata that might be useful to be posted back
    metadata: z.record(z.any()).optional(),
});

export type ExtractFeaturesRequest = z.infer<typeof ExtractFeaturesRequestSchema>;
