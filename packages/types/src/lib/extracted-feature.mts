import { z } from "zod";
import { HTMLElementFeatureSchema } from "./html-feature.mjs";
import { ViewportSchema } from "./viewport.mjs";
import { ImageFormatSchema } from "./image-formats.mjs";

export const ExtractedFeatureSchema = z.object({
    url: z.string().url(),
    features: HTMLElementFeatureSchema.array(),
    viewport: ViewportSchema,
    screenshot: z.object({
        buffer: z.string().base64(), // Base64 encoded screenshot
        format: ImageFormatSchema
    }),
});

export type ExtractedFeature = z.infer<typeof ExtractedFeatureSchema>;
