const express = require("express");
const router = express.Router();

const logger = require("../utils/logger");
const n = require("../utils/normalize");

const Policy = require("../models/Policy");
const User = require("../models/User");

function pagination(query) {
  const page = Math.max(1, parseInt(query.page || "1", 10) || 1);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(query.limit || "20", 10) || 20),
  );
  return { page, limit, skip: (page - 1) * limit };
}

// Search policy by user
router.get("/search", async (req, res) => {
  const username = n.text(req.query.username);
  const { page, limit, skip } = pagination(req.query);

  if (!username) {
    return res
      .status(400)
      .json({ error: "Query parameter 'username' is required." });
  }

  try {
    const term = username.toLowerCase();
    const userFilter = term.includes("@")
      ? { emailKey: term }
      : { nameKey: new RegExp(`^${n.escapeRegex(term)}`) };

    const users = await User.find(userFilter)
      .select("_id firstname email")
      .lean();

    if (users.length === 0) {
      return res.json({
        query: username,
        users: [],
        policies: [],
        meta: { total: 0, page, limit, pages: 0 },
      });
    }

    const filter = { userId: { $in: users.map((user) => user._id) } };

    const [total, policies] = await Promise.all([
      Policy.countDocuments(filter),
      Policy.find(filter)
        .populate("companyId", "company_name")
        .populate("categoryId", "category_name")
        .populate("accountId", "account_name account_type")
        .populate("agentId", "name")
        .populate("userId", "firstname email dob city state")
        .sort({ policy_start_date: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    logger.info(
      "search username=%s matched %d user(s), %d policies",
      username,
      users.length,
      total,
    );

    res.json({
      query: username,
      users,
      policies,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error("Search failed: %s", err.message);
    res.status(500).json({ error: "Search failed." });
  }
});

// aggregating policy information by user
router.get("/aggregate-by-user", async (req, res) => {
  const { page, limit, skip } = pagination(req.query);
  const includePolicies = /^(1|true|yes)$/i.test(
    req.query.includePolicies || "",
  );

  try {
    const pipeline = [
      {
        $group: {
          _id: "$userId",
          policyCount: { $sum: 1 },
          totalPremium: { $sum: { $ifNull: ["$premium_amount", 0] } },
          earliestStart: { $min: "$policy_start_date" },
          latestEnd: { $max: "$policy_end_date" },
          ...(includePolicies
            ? {
                policies: {
                  $push: {
                    policy_number: "$policy_number",
                    premium_amount: "$premium_amount",
                    policy_start_date: "$policy_start_date",
                    policy_end_date: "$policy_end_date",
                    categoryId: "$categoryId",
                    companyId: "$companyId",
                  },
                },
              }
            : {}),
        },
      },
      { $sort: { totalPremium: -1, _id: 1 } },
      {
        $facet: {
          data: [
            { $skip: skip },
            { $limit: limit },
            {
              $lookup: {
                from: "users",
                localField: "_id",
                foreignField: "_id",
                as: "user",
              },
            },
            { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
            {
              $project: {
                _id: 0,
                userId: "$_id",
                firstname: "$user.firstname",
                email: "$user.email",
                city: "$user.city",
                state: "$user.state",
                userType: "$user.userType",
                policyCount: 1,
                totalPremium: { $round: ["$totalPremium", 2] },
                earliestStart: 1,
                latestEnd: 1,
                ...(includePolicies ? { policies: 1 } : {}),
              },
            },
          ],
          totalCount: [{ $count: "count" }],
        },
      },
    ];

    // $lookup runs after $skip/$limit inside the facet, so only the current page
    // is joined against users rather than the whole collection.
    const [result = { data: [], totalCount: [] }] =
      await Policy.aggregate(pipeline);
    const total = result.totalCount?.[0]?.count || 0;

    res.json({
      data: result.data,
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error("Aggregation failed: %s", err.message);
    res.status(500).json({ error: "Aggregation failed." });
  }
});

module.exports = router;
