#!/usr/bin/env node
/**
 * FaceSense — Model Weight Downloader
 * ─────────────────────────────────────
 * Run ONCE before starting the dev server:
 *
 *   node scripts/download-models.js
 *
 * Downloads model files from the official face-api.js GitHub repo
 * into public/models/ so Next.js can serve them at /models/*.
 *
 * Files downloaded:
 *   • ssd_mobilenetv1_model-weights_manifest.json
 *   • ssd_mobilenetv1_model-shard1          (~5.4 MB)
 *   • ssd_mobilenetv1_model-shard2          (~5.4 MB)  ← SSD splits across 2 shards
 *   • face_landmark_68_model-weights_manifest.json
 *   • face_landmark_68_model-shard1         (~350 KB)
 */

const https = require("https");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

const BASE_URL =
  "https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights";

const OUT_DIR = path.join(__dirname, "..", "public", "models");

// SSD MobileNet v1 is ~11 MB split into TWO shards — both are required
const FILES = [
  "ssd_mobilenetv1_model-weights_manifest.json",
  "ssd_mobilenetv1_model-shard1",
  "ssd_mobilenetv1_model-shard2",
  "face_landmark_68_model-weights_manifest.json",
  "face_landmark_68_model-shard1",
];

// ── Ensure output directory exists ──────────────────────────────────────────
if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("Created directory: " + OUT_DIR);
}

// ── Download helper (follows redirects) ─────────────────────────────────────
function downloadFile(filename) {
  return new Promise((resolve, reject) => {
    const dest = path.join(OUT_DIR, filename);

    // Skip if already present and non-empty
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      console.log("   \u21A9  Already exists, skipping: " + filename);
      return resolve();
    }

    const tmpDest = dest + ".tmp";

    function fetchUrl(url, redirectCount) {
      if (redirectCount > 5) return reject(new Error("Too many redirects"));

      const lib = url.startsWith("https") ? https : http;

      lib
        .get(url, (res) => {
          // Follow redirects
          if (
            res.statusCode === 301 ||
            res.statusCode === 302 ||
            res.statusCode === 307
          ) {
            return fetchUrl(res.headers.location, redirectCount + 1);
          }

          if (res.statusCode !== 200) {
            return reject(new Error("HTTP " + res.statusCode + " for " + url));
          }

          const totalBytes = parseInt(
            res.headers["content-length"] || "0",
            10
          );
          let downloaded = 0;

          const file = fs.createWriteStream(tmpDest);

          res.on("data", (chunk) => {
            downloaded += chunk.length;
            if (totalBytes) {
              const pct = ((downloaded / totalBytes) * 100).toFixed(0);
              process.stdout.write(
                "\r   \u2B07  " + filename + " \u2014 " + pct + "%   "
              );
            }
          });

          res.pipe(file);

          file.on("finish", () => {
            file.close(() => {
              fs.renameSync(tmpDest, dest);
              const kb = (fs.statSync(dest).size / 1024).toFixed(1);
              process.stdout.write(
                "\r   \u2713  " + filename + " (" + kb + " KB)         \n"
              );
              resolve();
            });
          });

          file.on("error", (err) => {
            fs.unlink(tmpDest, () => {});
            reject(err);
          });
        })
        .on("error", (err) => {
          if (fs.existsSync(tmpDest)) fs.unlink(tmpDest, () => {});
          reject(err);
        });
    }

    console.log("   \u2B07  Downloading " + filename + "\u2026");
    fetchUrl(BASE_URL + "/" + filename, 0);
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(
    "\n\uD83E\uDDE0  FaceSense \u2014 Downloading face-api.js model weights"
  );
  console.log("    Output: " + OUT_DIR + "\n");

  let failed = 0;

  for (const file of FILES) {
    try {
      await downloadFile(file);
    } catch (err) {
      console.error("\n   \u2717  Failed: " + file);
      console.error("      " + err.message + "\n");
      failed++;
    }
  }

  console.log("");
  if (failed > 0) {
    console.error(
      "\u274C  " +
        failed +
        " file(s) failed. Check your internet connection and retry.\n"
    );
    process.exit(1);
  } else {
    console.log("\u2705  All models ready!  Run: npm run dev\n");
  }
})();
