const mongoose = require("mongoose");

const AccountSchema = new mongoose.Schema(
  {
    _id: mongoose.Schema.Types.ObjectId,
    account_name: { type: String, required: true },
    accountNameKey: { type: String, required: true },
    account_type: String,

    // The owning user. Previously absent, which left "User's Account" as an
    // orphan collection joinable only indirectly through Policy.
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  { timestamps: true, _id: false },
);

// Account names are not unique on their own: "Lura Lucca & Owen Dodson" belongs
// to two different people in the sample sheet. The owner is part of the key.
AccountSchema.index({ accountNameKey: 1, userId: 1 }, { unique: true });

module.exports =
  mongoose.models.Account || mongoose.model("Account", AccountSchema);
