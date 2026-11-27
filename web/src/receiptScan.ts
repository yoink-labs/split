import { createWorker } from "tesseract.js";
import { simd } from "wasm-feature-detect";
import workerPath from "tesseract.js/dist/worker.min.js?url";
import baselineCore from "tesseract.js-core/tesseract-core-lstm.wasm.js?url";
import simdCore from "tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url";
import model from "@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz?url";
import { parseReceiptText } from "./receiptText";

export async function readReceiptPhotos(photos: File[], signal: AbortSignal) {
  const corePath = (await simd()) ? simdCore : baselineCore;
  signal.throwIfAborted();
  const worker = await createWorker("eng", 1, {
    corePath,
    workerPath,
    workerBlobURL: false,
    langPath: new URL(".", new URL(model, location.href)).href.replace(/\/$/, ""),
  });
  if (signal.aborted) {
    await worker.terminate();
    signal.throwIfAborted();
  }
  const stop = () => { void worker.terminate(); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const pages: string[] = [];
    for (const photo of photos) {
      signal.throwIfAborted();
      const bitmap = await createImageBitmap(photo);
      const canvas = document.createElement("canvas");
      try {
        const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Could not read the photo.");
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const result = await worker.recognize(canvas);
        pages.push(result.data.text);
      } finally {
        bitmap.close();
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    return parseReceiptText(pages.join("\n"));
  } finally {
    signal.removeEventListener("abort", stop);
    if (!signal.aborted) await worker.terminate();
  }
}
