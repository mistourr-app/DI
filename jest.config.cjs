module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { module: 'commonjs', target: 'ES2020' } }]
  },
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js']
};