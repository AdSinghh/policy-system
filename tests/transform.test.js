const { transformRow } = require("../utils/transform");
const { deterministicId } = require("../utils/ids");

/** A row shaped like the sample sheet. */
const row = (overrides = {}) => ({
  agent: "Alex Watson",
  userType: "Active Client",
  policy_mode: "12",
  producer: "Brandie Placencia",
  policy_number: "YEEX9MOIBU7X",
  premium_amount: "1180.83",
  policy_type: "Single",
  company_name: "Integon Gen Ins Corp",
  category_name: "Commercial Auto",
  policy_start_date: "2018-11-02",
  policy_end_date: "2019-11-02",
  csr: "Tami Ellison",
  account_name: "Lura Lucca & Owen Dodson",
  email: "madler@yahoo.ca",
  gender: "",
  firstname: "Lura Lucca",
  city: "MOCKSVILLE",
  account_type: "Commercial",
  phone: "8677356559",
  address: "170 MATTHIAS CT",
  state: "NC",
  zip: "27028",
  dob: "1960-02-11",
  ...overrides,
});

describe("transformRow", () => {
  test("maps a well-formed row into all six entities", () => {
    const result = transformRow(row(), 2);

    expect(result.ok).toBe(true);
    expect(result.agent.set.name).toBe("Alex Watson");
    expect(result.carrier.set.company_name).toBe("Integon Gen Ins Corp");
    expect(result.category.set.category_name).toBe("Commercial Auto");
    expect(result.user.set.firstname).toBe("Lura Lucca");
    expect(result.account.set.account_name).toBe("Lura Lucca & Owen Dodson");
    expect(result.policy.set.policy_number).toBe("YEEX9MOIBU7X");
  });

  test("policy references the ids of the entities in the same row", () => {
    const { policy, user, agent, carrier, category, account } = transformRow(row(), 2);

    expect(policy.set.userId).toEqual(user._id);
    expect(policy.set.agentId).toEqual(agent._id);
    expect(policy.set.companyId).toEqual(carrier._id);
    expect(policy.set.categoryId).toEqual(category._id);
    expect(policy.set.accountId).toEqual(account._id);
  });

  /**
   * The regression that mattered most: two different people sharing one email.
   * Keying users on email merged 49 such pairs, overwrote the first person and
   * re-parented their policy onto the second.
   */
  test("two different people sharing an email stay two users", () => {
    const shared = "rbarreira@att.net";

    const first = transformRow(
      row({ firstname: "Shanelle Scheidegger", dob: "1980-07-11", email: shared, policy_number: "F9Y8F44TGVEY" }),
      2,
    );
    const second = transformRow(
      row({ firstname: "Esteban Grate", dob: "1961-06-17", email: shared, policy_number: "N2FXZXO9EBV2" }),
      3,
    );

    expect(first.user._id).not.toEqual(second.user._id);
    expect(first.policy.set.userId).toEqual(first.user._id);
    expect(second.policy.set.userId).toEqual(second.user._id);
  });

  test("the same person in two rows is one user", () => {
    const a = transformRow(row({ policy_number: "AAA111" }), 2);
    const b = transformRow(row({ policy_number: "BBB222" }), 3);

    expect(a.user._id).toEqual(b.user._id);
    expect(a.policy._id).not.toEqual(b.policy._id);
  });

  test("name matching ignores case and stray whitespace", () => {
    const a = transformRow(row(), 2);
    const b = transformRow(row({ firstname: "  lura   LUCCA " }), 3);

    expect(a.user._id).toEqual(b.user._id);
  });

  /** "Lura Lucca & Owen Dodson" belongs to two different people in the sheet. */
  test("one account name owned by two people yields two accounts", () => {
    const a = transformRow(row({ firstname: "Lura Lucca", dob: "1960-02-11" }), 2);
    const b = transformRow(row({ firstname: "High Low", dob: "1958-08-20" }), 3);

    expect(a.account.set.account_name).toBe(b.account.set.account_name);
    expect(a.account._id).not.toEqual(b.account._id);
    expect(a.account.set.userId).toEqual(a.user._id);
  });

  test("producer and csr live on the policy, not the agent", () => {
    const { policy, agent } = transformRow(row(), 2);

    expect(policy.set.producer).toBe("Brandie Placencia");
    expect(policy.set.csr).toBe("Tami Ellison");
    expect(agent.set).not.toHaveProperty("producer");
    expect(agent.set).not.toHaveProperty("csr");
  });

  test("ids are stable across calls, so re-import converges", () => {
    const a = transformRow(row(), 2);
    const b = transformRow(row(), 999);

    expect(a.policy._id).toEqual(b.policy._id);
    expect(a.user._id).toEqual(b.user._id);
    expect(a.policy._id).toEqual(deterministicId("policy", "yeex9moibu7x"));
  });

  describe("field handling", () => {
    test("a missing premium is null, not zero", () => {
      const { policy } = transformRow(row({ premium_amount: "", premium_amount_written: "" }), 2);
      expect(policy.set.premium_amount).toBeNull();
    });

    test("dates are parsed at UTC midnight, not shifted by the local zone", () => {
      const { policy } = transformRow(row(), 2);
      expect(policy.set.policy_start_date.toISOString()).toBe("2018-11-02T00:00:00.000Z");
    });

    test("ZIP+4 is kept as a string alongside a 5-digit form", () => {
      const { user } = transformRow(row({ zip: "27101-3843" }), 2);
      expect(user.set.zip).toBe("27101-3843");
      expect(user.set.zip5).toBe("27101");
    });

    test("formatted phone numbers and extensions are normalised", () => {
      const { user } = transformRow(row({ phone: "(336) 761-8572 Ext.0012" }), 2);
      expect(user.set.phone).toBe("(336) 761-8572 Ext.0012");
      expect(user.set.phoneDigits).toBe("3367618572");
      expect(user.set.phoneExtension).toBe("0012");
    });

    test("blank cells are omitted rather than stored as empty strings", () => {
      const { user } = transformRow(row({ city: "", state: "", address: "", zip: "" }), 2);
      expect(user.set).not.toHaveProperty("city");
      expect(user.set).not.toHaveProperty("state");
      expect(user.set).not.toHaveProperty("zip");
    });

    test("blank gender becomes null rather than an empty string", () => {
      const { user } = transformRow(row({ gender: "" }), 2);
      expect(user.set.gender ?? null).toBeNull();
    });

    test("city is captured", () => {
      const { user } = transformRow(row(), 2);
      expect(user.set.city).toBe("MOCKSVILLE");
    });

    test("column names are matched case- and separator-insensitively", () => {
      const result = transformRow(
        { Agent: "Alex Watson", "Policy Number": "ZZZ999", FirstName: "Jane Doe", DOB: "1970-01-01" },
        2,
      );
      expect(result.ok).toBe(true);
      expect(result.policy.set.policy_number).toBe("ZZZ999");
      expect(result.user.set.firstname).toBe("Jane Doe");
    });
  });

  describe("rejections", () => {
    test("a row with no policy number is skipped with a reason", () => {
      const result = transformRow(row({ policy_number: "" }), 7);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/policy_number/);
      expect(result.row).toBe(7);
    });

    test("a row with no name is skipped with a reason", () => {
      const result = transformRow(row({ firstname: "" }), 8);
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/firstname/);
    });
  });
});
