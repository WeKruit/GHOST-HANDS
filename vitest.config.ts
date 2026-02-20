import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
    test: {
        include: ['packages/ghosthands/__tests__/**/*.test.ts'],
        envFile: 'packages/ghosthands/.env',
    },
    resolve: {
        alias: {
            '@scripts/lib': path.resolve(__dirname, 'scripts/lib'),
        },
    },
});
