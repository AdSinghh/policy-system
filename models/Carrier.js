const mongoose = require("mongoose");

const CarrierSchema = new mongoose.Schema(
  {
    _id: mongoose.Schema.Types.ObjectId,
    company_name: { type: String, required: true },
    companyNameKey: { type: String, required: true, unique: true },
  },
  { timestamps: true, _id: false },
);

module.exports =
  mongoose.models.Carrier || mongoose.model("Carrier", CarrierSchema);
