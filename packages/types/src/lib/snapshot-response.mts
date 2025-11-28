import { z } from "zod";

export const SnapshotResponseSchema = z.object({
    snapshotId: z.string(),
});

export type SnapshotResponse = z.infer<typeof SnapshotResponseSchema>;
