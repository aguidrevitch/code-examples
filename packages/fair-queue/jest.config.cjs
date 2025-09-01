module.exports = {
    extensionsToTreatAsEsm: [".mts", ".ts"],
    verbose: true,
    testMatch: [
        "<rootDir>/tests/**/*.test.*"
    ],
    transform: {
        "^.+\\.(mts|ts)$": [
            "ts-jest",
            {
                useESM: true,
            }
        ]
    },
    transformIgnorePatterns: [
        "<rootDir>/node_modules/",
    ],
    moduleNameMapper: {
        "^@/(.*)$": "<rootDir>/src/$1"
    },
    resolver: "<rootDir>/jest.resolver.cjs",
    setupFiles: [
        "dotenv/config"
    ]
};