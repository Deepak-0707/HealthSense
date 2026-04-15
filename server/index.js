/**
 * FaceSense Phase 3 — Express Backend
 *
 * New in Phase 3:
 *   POST   /api/baseline        — save per-user calibration baseline
 *   GET    /api/baseline/:userId — fetch baseline + adaptive thresholds
 *   POST   /api/usermodel       — save KNN training samples
 *   GET    /api/usermodel/:userId — fetch user's KNN model
 *   DELETE /api/usermodel/:userId — clear user model
 *   POST   /api/session         — now accepts array (batching) + userId/sessionId
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");
const sessionRoutes = require("./routes/sessionRoutes");
const baselineRoutes = require("./routes/baselineRoutes");
const userModelRoutes = require("./routes/userModelRoutes");

const app = express();
const PORT = process.env.PORT || 5000;

connectDB();

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      /^http:\/\/localhost:\d+$/,
    ],
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json({ limit: "2mb" }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/session", sessionRoutes);
app.use("/api/baseline", baselineRoutes);
app.use("/api/usermodel", userModelRoutes);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "3.0", timestamp: new Date().toISOString() });
});

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`\n🚀  FaceSense Phase 3 backend running on http://localhost:${PORT}`);
  console.log(`    Health:     http://localhost:${PORT}/health`);
  console.log(`    Sessions:   http://localhost:${PORT}/api/session`);
  console.log(`    Stats:      http://localhost:${PORT}/api/session/stats`);
  console.log(`    Baseline:   http://localhost:${PORT}/api/baseline/:userId`);
  console.log(`    UserModel:  http://localhost:${PORT}/api/usermodel/:userId\n`);
});
