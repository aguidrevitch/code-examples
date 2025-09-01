import { z } from "zod";
import { ExtractedFeatureSchema } from "./extracted-feature.mjs";

const Base = {
    url: z.string().url(),
    metadata: z.record(z.unknown()).optional(),
};

export const ExtractFeaturesResponseSchema = z.union([
    z.object({
        ...Base,
        features: ExtractedFeatureSchema,
        error: z.undefined(),
    }),
    z.object({
        ...Base,
        features: z.undefined(),
        error: z.string(),
    }),
]);

export type ExtractFeaturesResponse = z.infer<typeof ExtractFeaturesResponseSchema>;
