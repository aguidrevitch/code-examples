import { z } from "zod";

// export interface HTMLElementFeature {
//     id: number;
//     parentId?: number;
//     nodeName: string;
//     outerHTML: string;
//     outerHTMLWithoutText: string;
//     textContent: string;
//     domPath?: string;
//     content?: string;
//     bbox: {
//         top: number;
//         right: number;
//         bottom: number;
//         left: number;
//         width: number;
//         height: number;
//         x: number;
//         y: number;
//     };
// }

export const HTMLElementFeatureSchema = z.object({
    id: z.number(),
    parentId: z.number().optional(),
    nodeName: z.string(),
    outerHTML: z.string(),
    outerHTMLWithoutText: z.string(),
    textContent: z.string().optional(),
    domPath: z.string().optional(),
    content: z.string().optional(),
    bbox: z.object({
        top: z.number(),
        right: z.number(),
        bottom: z.number(),
        left: z.number(),
        // width: z.number(),
        // height: z.number(),
        // x: z.number(),
        // y: z.number(),
    }),
    textBBoxes: z.array(z.object({
        top: z.number(),
        right: z.number(),
        bottom: z.number(),
        left: z.number(),
    })),
});

export type HTMLElementFeature = z.infer<typeof HTMLElementFeatureSchema>;