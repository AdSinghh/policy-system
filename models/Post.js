const mongoose = require("mongoose");

// The delivered message. This is the collection Task 2.2 asks the scheduler to
// insert into "at that particular day and time".
const PostSchema = new mongoose.Schema(
  {
    message: { type: String, required: true },
    scheduledPostId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ScheduledPost",
      index: true,
    },
    // When it was due, vs. when it actually landed. The gap is scheduler lag.
    scheduledFor: Date,
    publishedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

module.exports = mongoose.models.Post || mongoose.model("Post", PostSchema);
