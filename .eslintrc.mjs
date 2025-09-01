import esLintConfigPrettier from "eslint-config-prettier";
import typescriptParser from '@typescript-eslint/parser';
import typescriptPlugin from '@typescript-eslint/eslint-plugin';
import js from "@eslint/js";
import globals from "globals";

// import { FlatCompat } from "@eslint/eslintrc";

// console.log('esLintConfigRecommended', esLintConfigRecommended);
// const __dirname = new URL(".", import.meta.url).pathname;

// Translate ESLintRC-style configs into flat configs.
// const compat = new FlatCompat({
//     baseDirectory: __dirname,
//     // recommendedConfig: esLintConfigRecommended.configs["recommended"],
// });

export default [
    js.configs.recommended,
    // TypeScript configuration
    {
        files: ["**/*.ts", "**/*.mts"], // Match all TypeScript files
        languageOptions: {
            parser: typescriptParser,
            parserOptions: {
                project: "./tsconfig.json",
                // tsconfigRootDir: __dirname,
                // sourceType: 'module',
            },
        },
        plugins: {
            "@typescript-eslint": typescriptPlugin,
        },
        // extends: typescriptPlugin.configs.recommended.extends,
        rules: {
            // Add or customize TypeScript rules here
            ...typescriptPlugin.configs.recommended.rules,
            // '@typescript-eslint/explicit-module-boundary-types': 'warn',
            '@typescript-eslint/no-unused-vars': ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
            // '@typescript-eslint/no-explicit-any': 'warn',
            // '@typescript-eslint/consistent-type-imports': 'error',
            "no-undef": "off",
            "@typescript-eslint/ban-ts-comment": "off",
        },
    },

    // Flat config for turning off all rules that are unnecessary or might conflict with Prettier.
    esLintConfigPrettier,

    // Flat config for ESLint rules.
    {
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.browser,
            },
        },
        rules: {
            camelcase: ["error", { ignoreDestructuring: true }],

            "object-curly-spacing": ["error", "always"],
            indent: ["error", 4, { SwitchCase: 1 }],
            "linebreak-style": ["error", "unix"],
            quotes: ["error", "double", { "avoidEscape": true }],
            semi: ["error", "always"],

            // override configuration set by extending "eslint:recommended"
            "no-empty": "warn",
            "no-cond-assign": ["error", "always"],
            "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],

            // disable rules from base configurations
            "for-direction": "off",
        },
    },

    // Glob patterns for files and directories to be ignored.
    {
        ignores: [
            "node_modules", // Default directory to ignore
            "assets/", // Ignore all files in the assets directory
            "dist/",
            "**/*.min.js", // Ignore all minified JS files
            ".eslintrc.mjs", // Ignore this file
            // "test.mjs", // Ignore this file
            // "test/core.test.mjs",
        ],
    },
];

// import baseConfig from '../../.eslintrc.mjs';

// // const __dirname = new URL('.', import.meta.url).pathname;
// export default [
//     // Glob patterns for files and directories to be ignored.
//     {
//         ignores: [
//             'tests/',
//         ],
//     },
//     // TypeScript configuration
//     {
//         files: ['**/*.ts', '**/*.tsx'], // Match all TypeScript files
//         languageOptions: {
//             parser: typescriptParser,
//             parserOptions: {
//                 project: './tsconfig.json',
//                 // tsconfigRootDir: __dirname,
//                 // sourceType: 'module',
//             },
//         },
//         plugins: {
//             '@typescript-eslint': typescriptPlugin,
//         },
//         // ...tsRecommendedConfig, // Directly spread the TypeScript recommended configuration
//         rules: {
//             // Add or customize TypeScript rules here
//             ...typescriptPlugin.configs.recommended.rules,
//             '@typescript-eslint/explicit-module-boundary-types': 'warn',
//             '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
//             '@typescript-eslint/no-explicit-any': 'warn',
//             '@typescript-eslint/consistent-type-imports': 'error',
//           },
//     },
//     // ...tsRecommendedConfig, // Add the TypeScript recommended configuration to the base configuration
//     ...baseConfig,
// ];