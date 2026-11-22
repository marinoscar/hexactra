/** @type {import('jest').Config} */
module.exports = {
  rootDir: '..',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  // isolatedModules: each file is transpiled on its own (fast); `npm run typecheck` type-checks src/ and test/.
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: { isolatedModules: true } }] },
  testEnvironment: 'node',
  roots: ['<rootDir>/src/', '<rootDir>/test/'],
  testTimeout: 30000,
};
