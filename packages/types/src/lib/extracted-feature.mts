import { z } from "zod";
import { HTMLElementFeatureSchema } from "./html-feature.mjs";
import { ViewportSchema } from "./viewport.mjs";

export const ExtractedFeatureSchema = z.object({
    features: HTMLElementFeatureSchema.array(),
    viewport: ViewportSchema,
    screenshot: z.string().base64(), // Base64 encoded screenshot
});

export type ExtractedFeature = z.infer<typeof ExtractedFeatureSchema>;
