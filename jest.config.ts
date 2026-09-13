import type { Config } from 'jest';

// Unit tests (*.spec.ts) live next to the code; integration tests
// (*.e2e-spec.ts) live in test/ and need the local test database (.env.test).
const config: Config = {
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  transform: { '^.+\\.ts$': '<rootDir>/test/ts-transformer.js' },
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/**/*.module.ts', '!src/**/dto/*.ts'],
  testTimeout: 60000,
  maxWorkers: 1,
};
export default config;
