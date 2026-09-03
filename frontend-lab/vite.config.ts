import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds directly into the Flask app's static folder. Flask's catch-all route
// (src/main.py serve_app) serves any file that exists on disk under
// app.static_folder, so no backend changes are needed to serve this output.
//
// Filenames are fixed (no content hash) because index_lab.html includes this
// bundle via a hand-written <script> tag, not a generated manifest — a hashed
// filename would go stale on every rebuild.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../src/static/react',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/main.tsx',
      output: {
        entryFileNames: 'lab-islands.js',
        chunkFileNames: 'lab-islands-[name].js',
        assetFileNames: 'lab-islands[extname]',
      },
    },
  },
});
