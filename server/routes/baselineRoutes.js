const express = require("express");
const router = express.Router();
const Baseline = require("../models/Baseline");

// ─── POST /api/baseline ────────────────────────────────────────────────────────
// Save or update baseline for a user
router.post("/", async (req, res) => {
  try {
    const { userId, avgStress, avgBlinkRate, sampleCount } = req.body;

    if (!userId || typeof userId !== "string" || userId.trim() === "") {
      return res.status(400).json({ error: "userId is required" });
    }
    if (avgStress === undefined || isNaN(Number(avgStress))) {
      return res.status(400).json({ error: "avgStress must be a number" });
    }
    if (avgBlinkRate === undefined || isNaN(Number(avgBlinkRate))) {
      return res.status(400).json({ error: "avgBlinkRate must be a number" });
    }

    const baseline = await Baseline.findOneAndUpdate(
      { userId: userId.trim() },
      {
        userId: userId.trim(),
        avgStress: Number(avgStress),
        avgBlinkRate: Number(avgBlinkRate),
        sampleCount: Number(sampleCount) || 0,
        updatedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    return res.status(200).json({ success: true, baseline });
  } catch (err) {
    console.error("POST /api/baseline error:", err.message);
    return res.status(500).json({ error: "Failed to save baseline" });
  }
});

// ─── GET /api/baseline/:userId ─────────────────────────────────────────────────
router.get("/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: "userId required" });

    const baseline = await Baseline.findOne({ userId }).lean();
    if (!baseline) {
      return res.status(404).json({ error: "No baseline found", fallback: true });
    }

    // Compute adaptive thresholds
    const stressThreshold = Math.min(0.95, baseline.avgStress + 0.2);
    const blinkThreshold = baseline.avgBlinkRate * 0.7;

    return res.json({ baseline, stressThreshold, blinkThreshold });
  } catch (err) {
    console.error("GET /api/baseline error:", err.message);
    return res.status(500).json({ error: "Failed to fetch baseline" });
  }
});

module.exports = router;
