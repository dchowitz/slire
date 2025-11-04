export default {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.json', useESM: true }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['**/?(*.)+(spec|test).ts'],
  globalSetup: '<rootDir>/jest-emulator-setup.js',
  globalTeardown: '<rootDir>/jest-emulator-teardown.js',
  // Force Jest to exit after tests complete
  forceExit: true,
};
