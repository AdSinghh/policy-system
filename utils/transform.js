const n = require("./normalize");
const { deterministicId } = require("./ids");

/**
 * Turns one spreadsheet row into the six documents it implies.
 *
 * Pure and synchronous: no database, no I/O. That keeps the mapping rules — which
 * are the part most likely to be wrong — unit-testable without a Mongo instance.
 *
 * ── Identity ────────────────────────────────────────────────────────────────
 * Users are keyed on `name + dob`, deliberately NOT on email.
 *
 * In the sample sheet 47 email addresses are each shared by two unrelated people
 * (different name, different DOB, different phone — an artefact of how the data
 * was generated). Keying on email merges those pairs: 1,198 rows collapse to
 * 1,149 users, 49 people are overwritten, and their policies are re-parented onto
 * a stranger. `name + dob` is unique across all 1,198 rows and survives re-import.
 */

/** Column aliases, so a re-exported sheet with tidied headers still imports. */
const COLUMN = {
  agent: ["agent", "agent_name", "agentname"],
  producer: ["producer"],
  csr: ["csr"],
  policyNumber: ["policy_number", "policynumber", "policy no", "policy_no"],
  policyStartDate: ["policy_start_date", "policystartdate", "start_date"],
  policyEndDate: ["policy_end_date", "policyenddate", "end_date"],
  policyMode: ["policy_mode", "policymode"],
  policyType: ["policy_type", "policytype"],
  premiumAmount: ["premium_amount", "premiumamount", "premium"],
  premiumWritten: ["premium_amount_written", "premiumamountwritten"],
  companyName: ["company_name", "companyname", "carrier", "carrier_name"],
  categoryName: ["category_name", "categoryname", "lob", "line_of_business"],
  accountName: ["account_name", "accountname"],
  accountType: ["account_type", "accounttype"],
  firstName: ["firstname", "first_name", "user", "name"],
  email: ["email", "email_address"],
  gender: ["gender"],
  dob: ["dob", "date_of_birth", "birth_date"],
  address: ["address", "street", "address_1"],
  city: ["city"],
  state: ["state"],
  zip: ["zip", "zipcode", "zip_code", "postal_code"],
  phone: ["phone", "phone_number", "phonenumber"],
  userType: ["usertype", "user_type"],
};

/** Case- and separator-insensitive column read. */
function pick(row, aliases) {
  for (const alias of aliases) {
    if (row[alias] !== undefined) return row[alias];
  }
  const flatten = (s) => String(s).toLowerCase().replace(/[\s_-]/g, "");
  const wanted = aliases.map(flatten);
  for (const [column, value] of Object.entries(row)) {
    if (wanted.includes(flatten(column))) return value;
  }
  return undefined;
}

const GENDERS = { male: "Male", female: "Female", m: "Male", f: "Female" };

function transformRow(row, rowNumber) {
  const get = (field) => pick(row, COLUMN[field]);

  const firstName = n.text(get("firstName"));
  const policyNumber = n.text(get("policyNumber"));

  // A row without a policy number cannot be keyed, and a row without a person
  // cannot be attributed. Either way there is nothing safe to write.
  if (!policyNumber) {
    return { ok: false, row: rowNumber, reason: "missing policy_number" };
  }
  if (!firstName) {
    return { ok: false, row: rowNumber, reason: "missing firstname" };
  }

  const dob = n.date(get("dob"));
  const emailKey = n.key(get("email"));
  const nameKey = n.key(firstName);

  // dob is present on every row of the sample sheet; the fallbacks keep a
  // less tidy export importable rather than silently merging strangers.
  const userKey = dob
    ? `${nameKey}|${dob.toISOString().slice(0, 10)}`
    : emailKey
      ? `${nameKey}|${emailKey}`
      : nameKey;

  const agentName = n.text(get("agent")) || "Unknown";
  const companyName = n.text(get("companyName")) || "Unknown";
  const categoryName = n.text(get("categoryName")) || "Uncategorized";
  const accountName = n.text(get("accountName")) || firstName;

  const agentId = deterministicId("agent", n.key(agentName));
  const userId = deterministicId("user", userKey);
  const carrierId = deterministicId("carrier", n.key(companyName));
  const categoryId = deterministicId("category", n.key(categoryName));
  // Five account names in the sample sheet belong to two different people
  // ("Lura Lucca & Owen Dodson" is shared by Lura Lucca and High Low), so the
  // owner has to be part of the account's key.
  const accountId = deterministicId("account", n.key(accountName), userKey);
  const policyId = deterministicId("policy", n.key(policyNumber));

  const { phone, phoneDigits, phoneExtension } = n.phone(get("phone"));
  const { zip, zip5 } = n.zip(get("zip"));
  const gender = GENDERS[n.key(get("gender"))] || null;

  // premium_amount_written is empty in all 1,198 rows, but fall back to it
  // rather than assume that holds for every export.
  const premium = n.number(get("premiumAmount")) ?? n.number(get("premiumWritten"));

  return {
    ok: true,
    row: rowNumber,
    agent: {
      _id: agentId,
      set: n.compact({ name: agentName, nameKey: n.key(agentName) }),
    },
    user: {
      _id: userId,
      set: n.compact({
        firstname: firstName,
        nameKey,
        userKey,
        dob,
        email: n.text(get("email")) || null,
        emailKey: emailKey || null,
        gender,
        address: n.text(get("address")) || null,
        city: n.text(get("city")) || null,
        state: n.text(get("state")) || null,
        zip,
        zip5,
        phone,
        phoneDigits,
        phoneExtension,
        userType: n.text(get("userType")) || null,
      }),
    },
    account: {
      _id: accountId,
      set: n.compact({
        account_name: accountName,
        accountNameKey: n.key(accountName),
        account_type: n.text(get("accountType")) || null,
        userId,
      }),
    },
    category: {
      _id: categoryId,
      set: n.compact({
        category_name: categoryName,
        categoryNameKey: n.key(categoryName),
      }),
    },
    carrier: {
      _id: carrierId,
      set: n.compact({
        company_name: companyName,
        companyNameKey: n.key(companyName),
      }),
    },
    policy: {
      _id: policyId,
      set: {
        policy_number: policyNumber,
        policy_start_date: n.date(get("policyStartDate")),
        policy_end_date: n.date(get("policyEndDate")),
        policy_mode: n.number(get("policyMode")),
        policy_type: n.text(get("policyType")) || null,
        premium_amount: premium,
        // producer and csr vary per policy, not per agent: the sheet has 3 agents
        // but 50 producers and 66 CSRs. Storing them on Agent discards 47 and 65
        // of them respectively.
        producer: n.text(get("producer")) || null,
        csr: n.text(get("csr")) || null,
        agentId,
        userId,
        accountId,
        categoryId,
        companyId: carrierId,
      },
    },
  };
}

module.exports = { transformRow, pick, COLUMN };
