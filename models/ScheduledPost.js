const mongoose = require("mongoose");

const ScheduledPostSchema = new mongoose.Schema(
  {
    message: { type: String, required: true },

    day: { type: String, required: true },
    time: { type: String, required: true },
    timezone: { type: String, required: true, default: "UTC" },
    dayKind: { type: String, enum: ["date", "weekday"], required: true },

    runAt: { type: Date, required: true, index: true },

    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", "cancelled"],
      default: "pending",
      index: true,
    },

    claimedAt: Date,
    claimedBy: String,

    attempts: { type: Number, default: 0 },
    lastError: String,

    postId: { type: mongoose.Schema.Types.ObjectId, ref: "Post" },
    deliveredAt: Date,
  },
  { timestamps: true },
);

ScheduledPostSchema.index({ status: 1, runAt: 1 });

module.exports =
  mongoose.models.ScheduledPost ||
  mongoose.model("ScheduledPost", ScheduledPostSchema);
