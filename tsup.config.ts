import { defineConfig } from 'tsup';

// externalize deps so only src files are bundled
const external = ['mongodb', '@google-cloud/firestore', 'lodash'];

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  sourcemap: true,
  clean: true,
  dts: { resolve: true, compilerOptions: { tsconfig: 'tsconfig.build.json' } },
  tsconfig: 'tsconfig.build.json',
  bundle: true,
  external,
  treeshake: true,
});
