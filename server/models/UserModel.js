const mongoose = require("mongoose");

/**
 * UserModel — stores KNN training samples per user.
 * Each sample has a face descriptor vector (128-float array from face-api.js)
 * and a label ("relaxed" | "stressed").
 */
const UserModelSchema = new mongoose.Schema(
  {
    userId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    samples: [
      {
        descriptor: {
          type: [Number],
          required: true,
        },
        label: {
          type: String,
          enum: ["relaxed", "stressed"],
          required: true,
        },
        capturedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  {
    timestamps: true,
    collection: "usermodels",
  }
);

module.exports = mongoose.model("UserModel", UserModelSchema);
