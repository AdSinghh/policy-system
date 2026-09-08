const mongoose = require("mongoose");

const PolicySchema = new mongoose.Schema(
  {
    _id: mongoose.Schema.Types.ObjectId,

    // Unique, so re-running an import updates policies in place instead of
    // duplicating the whole dataset on every upload.
    policy_number: { type: String, required: true, unique: true },

    policy_start_date: Date,
    policy_end_date: Date,
    policy_mode: Number,
    policy_type: String,

    premium_amount: { type: Number, default: null },

    producer: String,
    csr: String,

    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Agent",
      index: true,
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    accountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Account",
      index: true,
    },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      index: true,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Carrier",
      index: true,
    },
  },
  { timestamps: true, _id: false },
);

PolicySchema.index({ userId: 1, premium_amount: 1 });

module.exports =
  mongoose.models.Policy || mongoose.model("Policy", PolicySchema);
