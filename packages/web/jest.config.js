module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // @wabi/shared's package "main" points at dist/, which only exists after a shared
    // build. Resolve it to its TS source so web's tests run without a prior dist build
    // (and a stale dist can't shadow source). ts-jest compiles it; tests that fully
    // factory-mock '@wabi/shared' never execute the barrel.
    '^@wabi/shared$': '<rootDir>/../shared/src/index.ts',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
    }],
  },
};
