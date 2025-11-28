import { FairQueuePayload } from "../types/fair-queue.mjs";

export interface FairQueueSerializedError {
    name: string;
    message: string;
    stack?: string;
    cause?: FairQueueSerializedError;
    payload?: FairQueuePayload;
    [key: string]: unknown;
}

export function serializeError(err: unknown): FairQueueSerializedError {
    if (err === null || err === undefined) {
        return { name: "Error", message: String(err) };
    }

    if (typeof err === "string") {
        return { name: "Error", message: err };
    }

    if (typeof err !== "object") {
        return { name: "Error", message: String(err) };
    }

    const e = err as Record<string, unknown> & { name?: string; message?: string; stack?: string };

    const base: FairQueueSerializedError = {
        name: typeof e.name === "string" ? e.name : "Error",
        message: typeof e.message === "string" ? e.message : "",
        stack: typeof e.stack === "string" ? e.stack : undefined,
        payload: typeof e.payload === "object" ? (e.payload as FairQueuePayload) : undefined,
        cause: e.cause ? serializeError(e.cause) : undefined,
    };

    for (const key of Object.keys(e)) {
        if (!(key in base)) {
            base[key] = e[key];
        }
    }

    return base;
}
