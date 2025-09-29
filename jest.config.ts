export default {
  displayName: 'smart-repo',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  transformIgnorePatterns: ['node_modules/(?!(lodash-es)/)'],
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/libs/smart-repo',
  globalSetup: '<rootDir>/jest-emulator-setup.js',
  globalTeardown: '<rootDir>/jest-emulator-teardown.js',
  // Force Jest to exit after tests complete
  forceExit: true,
};
