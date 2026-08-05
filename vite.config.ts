import { resolve } from 'node:path'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Builds only the React SPA. The Worker is bundled by wrangler from
// src/worker/index.ts — see wrangler.jsonc.
//
// NOTE: stack.md lists React Compiler via babel-plugin-react-compiler, but
// @vitejs/plugin-react v6 transforms with oxc and no longer takes a `babel` option;
// the compiler is wired through `reactCompilerPreset` instead. Left off here for the
// same reason Hot and Ask leave it off — it is an optimization, not a correctness
// requirement, and this is a demo. Revisit if this is ever promoted.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '~': resolve(import.meta.dirname, 'src') },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
})
