import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        // Tesseract looks up trained data by the language filename.
        assetFileNames: (asset) =>
          asset.names.includes("eng.traineddata.gz")
            ? "assets/ocr/tesseract-eng-1.0.0/eng.traineddata.gz"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
});
