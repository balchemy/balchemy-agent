/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  globals: {
    'ts-jest': {
      tsconfig: {
        strict: true,
        esModuleInterop: true,
        types: ['jest', 'node'],
        lib: ['ES2022'],
      },
      isolatedModules: true,
      diagnostics: { warnOnly: true },
    },
  },
  testMatch: ['**/__tests__/**/*.spec.ts', '**/*.spec.ts', '**/*.test.ts'],
  verbose: true,
};
