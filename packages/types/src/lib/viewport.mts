import { z } from "zod";

export const ViewportSchema = z.object({
    width: z.number(),
    height: z.number(),
    deviceScaleFactor: z.number().default(1),
    isLandscape: z.boolean().default(false),
    isMobile: z.boolean().default(false),
    hasTouch: z.boolean().default(false),
});

export type Viewport = z.infer<typeof ViewportSchema>;