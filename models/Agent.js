const mongoose = require("mongoose");

const AgentSchema = new mongoose.Schema(
  {
    _id: mongoose.Schema.Types.ObjectId,
    name: { type: String, required: true },
    // Lowercased form of `name`, used as the natural key. `producer` used to live
    // here, but the sheet has 3 agents and 50 producers — producer varies per
    // policy, so keeping it on Agent silently discarded 47 of them. It now lives
    // on Policy.
    nameKey: { type: String, required: true, unique: true },
  },
  { timestamps: true, _id: false },
);

module.exports = mongoose.models.Agent || mongoose.model("Agent", AgentSchema);
