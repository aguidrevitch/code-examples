import { z } from "zod";

export const ImageFormatSchema = z.enum(["png", "jpeg", "webp"]);

export type ImageFormat = z.infer<typeof ImageFormatSchema>;
