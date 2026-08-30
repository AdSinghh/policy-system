const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    _id: mongoose.Schema.Types.ObjectId,

    firstname: { type: String, required: true },
    // Lowercased `firstname`. Search matches against this so user input never
    // has to be interpolated into a case-insensitive RegExp.
    nameKey: { type: String, required: true, index: true },

    /**
     * The natural key: `name|dob` (falling back to `name|email`, then `name`).
     *
     * Explicitly NOT email. In the sample sheet 47 addresses are each shared by
     * two unrelated people, so keying on email merged 49 distinct users into
     * their neighbours and re-parented their policies. `name + dob` is unique
     * across all 1,198 rows.
     */
    userKey: { type: String, required: true, unique: true },

    dob: Date,
    email: String,
    emailKey: { type: String, index: true },
    gender: { type: String, enum: ["Male", "Female", null], default: null },

    address: String,
    city: String,
    state: String,
    // Kept as strings: ZIPs arrive as both 27028 and 27101-3843, and parsing
    // them as numbers eats the leading zero on north-eastern codes.
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

// Anchored prefix search on an indexed key (see routes/policy.js).
UserSchema.index({ nameKey: 1, _id: 1 });

module.exports = mongoose.models.User || mongoose.model("User", UserSchema);
