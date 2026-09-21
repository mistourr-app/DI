module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { tsconfig: { module: 'commonjs', target: 'ES2020', esModuleInterop: true } }
    ]
  },
  testMatch: ['**/e2e/**/*.e2e.ts'],
  moduleFileExtensions: ['ts', 'js'],
  testTimeout: 120000,
  maxWorkers: 1
};
