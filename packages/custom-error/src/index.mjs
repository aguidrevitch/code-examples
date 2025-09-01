export class CustomError extends Error {
    context = {};
    /**
     * CustomError constructor
     * @param {string} message - Error message
     * @param {object} [context={}] - Additional context for the error
     */
    constructor(message, context = {}) {
        if (typeof message !== "string" || message.length === 0) {
            throw new Error("Message must be a non-empty string");
        }
        super(message);
        this.name = this.constructor.name;
        this.context = context;

        // Maintains proper stack trace in V8
        Error.captureStackTrace(this, this.constructor);
    }
}
