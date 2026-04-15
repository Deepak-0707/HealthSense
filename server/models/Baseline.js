const mongoose = require("mongoose");

/**
 * Baseline — per-user calibration data collected during the first 30–60s of a session.
 * Used to compute adaptive thresholds for stress and blink alerts.
 */
const BaselineSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    avgStress: {
      type: Number,
      min: 0,
      max: 1,
      default: 0,
    },
    avgBlinkRate: {
      type: Number,
      min: 0,
      default: 15,
    },
    sampleCount: {
      type: Number,
      default: 0,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    collection: "baselines",
  }
);

module.exports = mongoose.model("Baseline", BaselineSchema);
