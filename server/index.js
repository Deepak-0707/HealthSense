/**
 * FaceSense Phase 2 — Express Backend
 *
 * Start:
 *   cd server
 *   cp .env.example .env   # fill in MONGO_URI
 *   npm install
 *   npm start              # production
 *   npm run dev            # development (nodemon)
 *
 * Endpoints:
 *   POST   /api/session        — save analytics snapshot
 *   GET    /api/session        — fetch history (?limit=50&since=<ISO>)
 *   GET    /api/session/stats  — aggregated averages + emotion breakdown
 *   GET    /health             — quick health check
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const connectDB = require("./config/db");
const sessionRoutes = require("./routes/sessionRoutes");

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Connect to MongoDB ────────────────────────────────────────────────────────
connectDB();

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(
  cors({
    // Allow the Next.js dev server (and any localhost port) to call us
    origin: [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      /^http:\/\/localhost:\d+$/,
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json({ limit: "1mb" }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/session", sessionRoutes);

// Health check — used by the frontend backend-status indicator
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀  FaceSense backend running on http://localhost:${PORT}`);
  console.log(`    Health:   http://localhost:${PORT}/health`);
  console.log(`    Sessions: http://localhost:${PORT}/api/session`);
  console.log(`    Stats:    http://localhost:${PORT}/api/session/stats\n`);
});
