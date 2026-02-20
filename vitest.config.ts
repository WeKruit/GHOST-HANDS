import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Node 22+ built-in: load all env vars from the ghosthands .env
process.loadEnvFile('packages/ghosthands/.env');

export default defineConfig({
    test: {
        include: ['packages/ghosthands/__tests__/**/*.test.ts'],
    },
    resolve: {
        alias: {
            '@scripts/lib': path.resolve(__dirname, 'scripts/lib'),
        },
    },
});
