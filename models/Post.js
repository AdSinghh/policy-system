const mongoose = require("mongoose");

const PostSchema = new mongoose.Schema(
  {
    message: { type: String, required: true },
    scheduledPostId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ScheduledPost",
      index: true,
    },

    scheduledFor: Date,
    publishedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

module.exports = mongoose.models.Post || mongoose.model("Post", PostSchema);
