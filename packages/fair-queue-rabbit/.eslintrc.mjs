import baseConfig from '../../.eslintrc.mjs';

export default [
    // Glob patterns for files and directories to be ignored.
    {
        ignores: [
            'dist/'
        ],
    },
    ...baseConfig,
];
