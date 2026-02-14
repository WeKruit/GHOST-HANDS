import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['packages/ghosthands/__tests__/**/*.test.ts'],
        envFile: 'packages/ghosthands/.env',
    },
});
