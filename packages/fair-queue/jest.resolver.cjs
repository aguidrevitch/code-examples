const EXTENSION_REPLACEMENTS = [
    { from: ".js", to: [".ts", ".d.ts"] },
    { from: ".mjs", to: [".mts"] },
];

module.exports = function resolver(/** @type {string} */ request, /** @type {{ defaultResolver: (arg0: string, arg1: any) => any; }} */ options) {
    try {
        return options.defaultResolver(request, options);
    } catch (error) {
        for (const { from, to } of EXTENSION_REPLACEMENTS) {
            if (request.slice(-from.length) === from) {
                for (const ext of to) {
                    try {
                        return options.defaultResolver(
                            request.slice(0, -from.length) + ext,
                            options,
                        );
                    } catch {
                        // If nothing works, the original error will be re-thrown, so this
                        // one is unneeded.
                    }
                }
            }
        }

        // None of the replacement extensions worked; re-throw the original error.
        throw error;
    }
};