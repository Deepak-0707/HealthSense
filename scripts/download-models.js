#!/usr/bin/env node
const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

// Primary + fallback sources
const BASE_URLS = [
  "https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights",
  "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js/weights"
];

const OUT_DIR = path.join(__dirname, "..", "public", "models");

const FILES = [
  // Phase 1
  "ssd_mobilenetv1_model-weights_manifest.json",
  "ssd_mobilenetv1_model-shard1",
  "ssd_mobilenetv1_model-shard2",
  "face_landmark_68_model-weights_manifest.json",
  "face_landmark_68_model-shard1",

  // Phase 2 (FIXED)
  "face_expression_model-weights_manifest.json",
  "face_expression_model-shard1",
];

if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("Created directory: " + OUT_DIR);
}

function fetchWithFallback(filename, attempt = 0) {
  return new Promise((resolve, reject) => {
    if (attempt >= BASE_URLS.length) {
      return reject(new Error("All sources failed"));
    }

    const url = BASE_URLS[attempt] + "/" + filename;
    const dest = path.join(OUT_DIR, filename);
    const tmpDest = dest + ".tmp";

    const lib = url.startsWith("https") ? https : http;

    console.log(`   ⬇ Downloading ${filename} (source ${attempt + 1})...`);

    lib.get(url, (res) => {
      if (res.statusCode !== 200) {
        console.log(`   ↻ Switching source for ${filename}`);
        return resolve(fetchWithFallback(filename, attempt + 1));
      }

      const totalBytes = parseInt(res.headers["content-length"] || "0", 10);
      let downloaded = 0;

      const file = fs.createWriteStream(tmpDest);

      res.on("data", (chunk) => {
        downloaded += chunk.length;
        if (totalBytes) {
          const pct = ((downloaded / totalBytes) * 100).toFixed(0);
          process.stdout.write(`\r   ⬇ ${filename} — ${pct}%   `);
        }
      });

      res.pipe(file);

      file.on("finish", () => {
        file.close(() => {
          fs.renameSync(tmpDest, dest);
          const kb = (fs.statSync(dest).size / 1024).toFixed(1);
          process.stdout.write(`\r   ✓ ${filename} (${kb} KB)\n`);
          resolve();
        });
      });

      file.on("error", (err) => {
        fs.unlink(tmpDest, () => {});
        reject(err);
      });

    }).on("error", () => {
      if (fs.existsSync(tmpDest)) fs.unlink(tmpDest, () => {});
      resolve(fetchWithFallback(filename, attempt + 1));
    });
  });
}

(async () => {
  console.log("\n🧠 FaceSense Phase 2 — Downloading face-api.js model weights");
  console.log("    Output: " + OUT_DIR + "\n");

  let failed = 0;

  for (const file of FILES) {
    const dest = path.join(OUT_DIR, file);

    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log("   ↩ Already exists, skipping: " + file);
      continue;
    }

    try {
      await fetchWithFallback(file);
    } catch (err) {
      console.error("\n   ✗ Failed: " + file);
      console.error("      " + err.message + "\n");
      failed++;
    }
  }

  console.log("");
  if (failed > 0) {
    console.error(`❌ ${failed} file(s) failed.`);
    process.exit(1);
  } else {
    console.log("✅ All models ready (Phase 1 + Phase 2). Run: npm run dev\n");
  }
})();