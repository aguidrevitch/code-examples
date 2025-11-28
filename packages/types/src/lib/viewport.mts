import { z } from "zod";

export const ViewportSchema = z.object({
    name: z.string().optional(),
    width: z.number(),
    height: z.number(),
    deviceScaleFactor: z.number().default(1).optional(),
    isLandscape: z.boolean().default(false).optional(),
    isMobile: z.boolean().default(false).optional(),
    hasTouch: z.boolean().default(false).optional(),
});

export type Viewport = z.infer<typeof ViewportSchema>;