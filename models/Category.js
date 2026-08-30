const mongoose = require("mongoose");

// Policy category, referred to as LOB (line of business) in the brief.
const CategorySchema = new mongoose.Schema(
  {
    _id: mongoose.Schema.Types.ObjectId,
    category_name: { type: String, required: true },
    categoryNameKey: { type: String, required: true, unique: true },
  },
  { timestamps: true, _id: false },
);

module.exports =
  mongoose.models.Category || mongoose.model("Category", CategorySchema);
