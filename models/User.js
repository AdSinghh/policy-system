const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    _id: mongoose.Schema.Types.ObjectId,

    firstname: { type: String, required: true },

    nameKey: { type: String, required: true, index: true },

    userKey: { type: String, required: true, unique: true },

    dob: Date,
    email: String,
    emailKey: { type: String, index: true },
    gender: { type: String, enum: ["Male", "Female", null], default: null },

    address: String,
    city: String,
    state: String,

    zip: String,
    zip5: String,

    phone: String,
    // Digits only, so "8677356559", "(336) 245-8310" and the same number with an
    // extension are all searchable as one value.
    phoneDigits: { type: String, index: true },
    phoneExtension: String,

    userType: String,
  },
  { timestamps: true, _id: false },
);

UserSchema.index({ nameKey: 1, _id: 1 });

module.exports = mongoose.models.User || mongoose.model("User", UserSchema);
