const express = require("express");
const router = express.Router();
const Session = require("../models/Session");

// ─── POST /api/session ─────────────────────────────────────────────────────────
// Save one analytics snapshot from the frontend.
// Body: { emotion, stressScore, blinkRate, timestamp }
router.post("/", async (req, res) => {
  try {
    const { emotion, stressScore, blinkRate, timestamp } = req.body;

    // Basic validation
    if (stressScore === undefined || blinkRate === undefined) {
      return res.status(400).json({ error: "stressScore and blinkRate are required" });
    }

    const session = new Session({
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      emotion: emotion || "neutral",
      stressScore: Number(stressScore),
      blinkRate: Number(blinkRate),
    });

    const saved = await session.save();
    return res.status(201).json({ success: true, id: saved._id });
  } catch (err) {
    console.error("POST /api/session error:", err.message);
    return res.status(500).json({ error: "Failed to save session data" });
  }
});

// ─── GET /api/session ──────────────────────────────────────────────────────────
// Fetch session history, newest first.
// Optional query params:
//   ?limit=50      — max records to return (default 100, max 500)
//   ?since=<ISO>   — only records after this datetime
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const filter = {};

    if (req.query.since) {
      filter.timestamp = { $gte: new Date(req.query.since) };
    }

    const sessions = await Session.find(filter)
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    return res.json({ count: sessions.length, data: sessions });
  } catch (err) {
    console.error("GET /api/session error:", err.message);
    return res.status(500).json({ error: "Failed to fetch session data" });
  }
});

// ─── GET /api/session/stats ────────────────────────────────────────────────────
// Aggregate summary for the last N records.
router.get("/stats", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);

    const agg = await Session.aggregate([
      { $sort: { timestamp: -1 } },
      { $limit: limit },
      {
        $group: {
          _id: null,
          avgStress: { $avg: "$stressScore" },
          maxStress: { $max: "$stressScore" },
          avgBlinkRate: { $avg: "$blinkRate" },
          count: { $sum: 1 },
        },
      },
    ]);

    const emotionCounts = await Session.aggregate([
      { $sort: { timestamp: -1 } },
      { $limit: limit },
      { $group: { _id: "$emotion", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    return res.json({
      summary: agg[0] ?? { avgStress: 0, maxStress: 0, avgBlinkRate: 0, count: 0 },
      emotionBreakdown: emotionCounts,
    });
  } catch (err) {
    console.error("GET /api/session/stats error:", err.message);
    return res.status(500).json({ error: "Failed to compute stats" });
  }
});

module.exports = router;
