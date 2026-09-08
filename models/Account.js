const mongoose = require("mongoose");

const AccountSchema = new mongoose.Schema(
  {
    _id: mongoose.Schema.Types.ObjectId,
    account_name: { type: String, required: true },
    accountNameKey: { type: String, required: true },
    account_type: String,

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
  },
  { timestamps: true, _id: false },
);

AccountSchema.index({ accountNameKey: 1, userId: 1 }, { unique: true });

module.exports =
  mongoose.models.Account || mongoose.model("Account", AccountSchema);
