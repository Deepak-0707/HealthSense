const mongoose = require("mongoose");

/**
 * Session — one analytics snapshot every ~3 seconds while camera is active.
 *
 * Fields:
 *   timestamp  — ISO string from the client (when the snapshot was taken)
 *   emotion    — dominant emotion label (happy | sad | angry | fearful | disgusted | surprised | neutral)
 *   stressScore — 0.0 – 1.0  (computed from emotion weights on the client)
 *   blinkRate  — blinks per minute (rolling, computed since session start)
 */
const SessionSchema = new mongoose.Schema(
  {
    timestamp: {
      type: Date,
      default: Date.now,
    },
    emotion: {
      type: String,
      enum: ["happy", "sad", "angry", "fearful", "disgusted", "surprised", "neutral"],
      default: "neutral",
    },
    stressScore: {
      type: Number,
      min: 0,
      max: 1,
      default: 0,
    },
    blinkRate: {
      type: Number,
      min: 0,
      default: 0,
    },
  },
  {
    // Automatically adds createdAt / updatedAt
    timestamps: true,
    // Keep the collection name explicit
    collection: "sessions",
  }
);

module.exports = mongoose.model("Session", SessionSchema);
