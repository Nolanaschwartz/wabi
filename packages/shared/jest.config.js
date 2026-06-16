module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js'],
  testMatch: ['**/__tests__/**/*.spec.ts', '**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { diagnostics: false }] },
};
