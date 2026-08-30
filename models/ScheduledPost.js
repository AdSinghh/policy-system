const mongoose = require("mongoose");

const ScheduledPostSchema = new mongoose.Schema(
  {
    message: { type: String, required: true },

    // Exactly what the client sent, kept for auditability.
    day: { type: String, required: true },
    time: { type: String, required: true },
    timezone: { type: String, required: true, default: "UTC" },
    dayKind: { type: String, enum: ["date", "weekday"], required: true },

    // The absolute instant `day` + `time` + `timezone` resolve to. All scheduling
    // decisions use this, so behaviour no longer depends on the container's TZ.
    runAt: { type: Date, required: true, index: true },

    status: {
      type: String,
      enum: ["pending", "processing", "completed", "failed", "cancelled"],
      default: "pending",
      index: true,
    },

    // Set when a scheduler claims the row. A claim older than
    // SCHEDULER_CLAIM_TIMEOUT_MS is assumed to belong to a process that died
    // (a CPU restart, say) and is released back to pending.
    claimedAt: Date,
    claimedBy: String,

    attempts: { type: Number, default: 0 },
    lastError: String,

    postId: { type: mongoose.Schema.Types.ObjectId, ref: "Post" },
    deliveredAt: Date,
  },
  { timestamps: true },
);

// The scheduler's claim query: due, and in a claimable state.
ScheduledPostSchema.index({ status: 1, runAt: 1 });

module.exports =
  mongoose.models.ScheduledPost ||
  mongoose.model("ScheduledPost", ScheduledPostSchema);
