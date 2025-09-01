export class CustomError extends Error {
    public context: Record<string, unknown>;
    constructor(message: string, context?: Record<string, unknown>);
}