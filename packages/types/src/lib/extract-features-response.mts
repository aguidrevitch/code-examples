import { z } from "zod";
import { ExtractedFeature, ExtractedFeatureSchema } from "./extracted-feature.mjs";
import { ExtractedFeatureError, ExtractedFeatureErrorSchema } from "./extracted-feature-error.mjs";

// prettier-ignore
export const ExtractFeaturesResponseSchema = z.union([
    ExtractedFeatureSchema,
    ExtractedFeatureErrorSchema,
]);

export type ExtractFeaturesResponse = z.infer<typeof ExtractFeaturesResponseSchema>;

// typeguard helper
export const isExtractedFeatureSuccess = (obj: unknown): obj is ExtractedFeature => {
    return (obj as ExtractedFeatureError).error === undefined;
};

export const isExtractedFeatureError = (obj: unknown): obj is ExtractedFeatureError => {
    return (obj as ExtractedFeatureError).error !== undefined;
};
