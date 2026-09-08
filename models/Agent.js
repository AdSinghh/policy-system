const mongoose = require("mongoose");

const AgentSchema = new mongoose.Schema(
  {
    _id: mongoose.Schema.Types.ObjectId,
    name: { type: String, required: true },

    nameKey: { type: String, required: true, unique: true },
  },
  { timestamps: true, _id: false },
);

module.exports = mongoose.models.Agent || mongoose.model("Agent", AgentSchema);
