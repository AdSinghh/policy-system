const mongoose = require("mongoose");

// Tracks one upload end to end. The upload endpoint returns a job id immediately
// and the client polls this document; previously the API answered {ok:true} and
// the caller had no way to learn about progress or failure.
const ImportJobSchema = new mongoose.Schema(
  {
    originalName: String,
    storedPath: String,
    sizeBytes: Number,

    status: {
      type: String,
      enum: ["queued", "running", "completed", "partial", "failed"],
      default: "queued",
      index: true,
    },

    workerCount: Number,
    processedRows: { type: Number, default: 0 },
    skippedRows: { type: Number, default: 0 },
    failedRows: { type: Number, default: 0 },

    // Capped: a malformed file should not write a million-element array.
    // Named rowErrors because `errors` is a reserved Mongoose document path.
    rowErrors: [
      {
        _id: false,
        row: Number,
        reason: String,
      },
    ],

    // Collection sizes once the run finishes, for a quick sanity check.
    counts: {
      agents: Number,
      users: Number,
      accounts: Number,
      categories: Number,
      carriers: Number,
      policies: Number,
    },

    startedAt: Date,
    finishedAt: Date,
    durationMs: Number,
    error: String,
  },
  { timestamps: true },
);

module.exports =
  mongoose.models.ImportJob || mongoose.model("ImportJob", ImportJobSchema);
