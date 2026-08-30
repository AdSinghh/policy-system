# Policy Management API

Backend for the Node.js assessment. Imports insurance policy sheets (CSV or XLSX)
into six MongoDB collections using a pool of worker threads, serves search and
per-user aggregation, restarts itself under sustained CPU load, and delivers
messages at a scheduled instant.

Express + Mongoose, plain JavaScript, Docker. No frontend — this repository is
backend only.

---

## Quick start

```bash
cp .env.example .env          # set MONGO_URI
docker compose up --build     # API on :4000, Mongo on :27017
```

Or against your own Mongo:

```bash
npm install
MONGO_URI="mongodb://localhost:27017/policydb" npm run indexes
MONGO_URI="mongodb://localhost:27017/policydb" npm start
```

`npm run indexes` builds the unique natural-key indexes. Run it once per
database — they are what stop a second upload from duplicating the dataset.

Swagger UI: <http://localhost:4000/api-docs>

---

## Try it

```bash
# 1. Import the sheet — returns a job id immediately
curl -X POST localhost:4000/api/upload -F "file=@data-sheet.csv"
# → {"jobId":"6a9482...","status":"queued","statusUrl":"/api/imports/6a9482..."}

# 2. Follow the import
curl localhost:4000/api/imports/6a9482...
# → status, processedRows, and per-collection counts

# 3. Find a user's policies
curl --get localhost:4000/api/policies/search --data-urlencode "username=Lura Lucca"

# 4. Aggregate per user
curl "localhost:4000/api/policies/aggregate-by-user?limit=5&includePolicies=true"

# 5. Schedule a message
curl -X POST localhost:4000/api/schedules -H 'Content-Type: application/json' \
  -d '{"message":"Renewal reminder","day":"2026-09-05","time":"14:30","timezone":"Asia/Kolkata"}'

# 6. Watch the CPU watchdog restart the worker
curl -X POST "localhost:4000/api/system/load?seconds=12"
```

---

## Data model

Six collections, as the brief specifies, plus three supporting ones.

```
Agent ──────┐
Carrier ────┤
Category ───┼──< Policy >──── User ──< Account
            │                   │
            └───────────────────┘
```

| Collection   | Key fields | Natural key |
| ------------ | ---------- | ----------- |
| `agents`     | name | `nameKey` |
| `users`      | firstname, dob, email, gender, address, city, state, zip, phone, userType | `userKey` = `name\|dob` |
| `accounts`   | account_name, account_type, **userId** | `(accountNameKey, userId)` |
| `categories` | category_name — the LOB | `categoryNameKey` |
| `carriers`   | company_name | `companyNameKey` |
| `policies`   | policy_number, start/end dates, mode, type, premium, **producer**, **csr**, and the five foreign keys | `policy_number` |

Supporting: `importjobs` (upload progress), `scheduledposts` (the queue),
`posts` (delivered messages).

### Why users are keyed on name + dob, not email

In the supplied sheet **47 email addresses are each shared by two unrelated
people** — different name, different date of birth, different phone. Keying users
on email merges those pairs: 1,198 rows collapse into 1,149 users, 49 people are
overwritten by whoever came next in the file, and their policies are silently
re-parented onto a stranger. `name + dob` is unique across all 1,198 rows.

```
keyed on email          keyed on name + dob
  users        1149        users        1198
  users lost     49        users lost      0
  mis-filed      49        mis-filed       0
```

### Idempotent imports

Every `_id` is derived from its natural key
(`ObjectId(sha1(key)[0:24])`, see `utils/ids.js`). Two consequences:

- Import workers never coordinate. A policy can reference a carrier in the same
  batch that creates it, and two workers writing the same carrier converge
  instead of colliding — no read-back round trip, no duplicate-key retry loop.
- Re-uploading a sheet updates the same documents. Upload the sample sheet twice
  and you still have exactly 1,198 policies.

---

## How each requirement is implemented

### Task 1.1 — Upload via worker threads

`POST /api/upload` stores the file, creates an `ImportJob`, and answers **202
with a job id**. `services/importRunner.js` spawns `IMPORT_WORKERS` threads
(default `min(cpus-1, 4)`).

Each worker opens the file itself and processes only the rows where
`rowIndex % workerCount === workerIndex`. Parsing is repeated per worker, but
parsing is cheap next to database round trips, and this keeps every worker
streaming — memory stays flat regardless of file size.

Rows accumulate into batches of `IMPORT_BATCH_SIZE` (default 200) and are written
as six unordered `bulkWrite` calls per batch, not six queries per row.

Measured on the 1,198-row sheet, 4 workers, local Mongo:

```
status     completed          agents         3
processed  1198               users       1198
skipped       0               accounts    1198
duration   1286 ms            categories    19
                              carriers      46
                              policies    1198
```

A 14,376-row file imports in 11.2 s, split evenly at 3,594 rows per worker.

### Task 1.2 — Search by username

`GET /api/policies/search?username=` matches an **anchored, escaped prefix**
against the user's normalised `nameKey`; a term containing `@` is matched against
`emailKey` instead. Policies come back with carrier, category, account and agent
resolved, and are paginated.

### Task 1.3 — Aggregate per user

`GET /api/policies/aggregate-by-user` groups by `userId` for count, premium total
and the covered date span, with `$facet` pagination. `$lookup` runs *after*
`$skip`/`$limit`, so only the current page is joined against `users`.
`?includePolicies=true` nests the policies themselves.

> On this dataset every user holds exactly one policy, so all counts are 1. That
> is a property of the sample sheet. The email-keyed version reported 47 users
> with two policies, but each of those was two different people merged by a
> shared address.

### Task 2.1 — Restart at 70% CPU

`server.js` runs a cluster primary that forks the API worker(s) and stays
deliberately idle — no database connection, no traffic — so its own CPU never
confuses the measurement and it stays responsive enough to replace a worker
pinned at 100%.

`utils/cpuMonitor.js` samples the worker with `pidusage` every second and trips
after `CPU_SUSTAINED_SAMPLES` consecutive readings above the threshold. The
sampler only *detects*; the primary decides what a trip means:

- **Graceful drain.** The worker is asked to stop accepting connections, finish
  in-flight requests, close Mongo, and exit. `SIGKILL` is held in reserve for
  `CPU_DRAIN_TIMEOUT_MS` in case it never stops.
- **Cooldown.** No further trips are evaluated until the replacement has booted
  and connected, so a genuinely busy box cannot restart-loop.
- **Import awareness.** A large import legitimately pins the CPU. Workers report
  import state to the primary over cluster IPC, and restarts are suppressed while
  one is running — otherwise the watchdog kills the import it is measuring and
  leaves a half-written database. Set `CPU_RESTART_DURING_IMPORT=true` to opt out.

Demonstrate it with `POST /api/system/load?seconds=12`:

```
warn: Load generator: burning CPU for 12s on pid 50383
warn: CPU at 99% (threshold 70%) for 5 consecutive samples — restarting worker
warn: Recycling worker pid=50383 (cpu threshold exceeded); draining up to 15000ms
info: Worker pid=50383 draining (supervisor requested shutdown)
info: Worker pid=50383 exited (code=0 signal=none)
info: Forked API worker pid=52670
info: API worker pid=52670 listening on 4100
```

Exit code 0 — drained, not killed. And with an import in flight:

```
warn: CPU at 99% for 5s, but an import is running — restart suppressed
info: Import 6a948311... finished: processed=14376 skipped=0 in 11166ms
```

> With `CLUSTER_WORKERS=1` a restart is a brief outage. Set it to 2+ and the
> primary recycles one worker while the other serves. 1 is the default only
> because it makes the demo legible.

### Task 2.2 — Scheduled messages

`POST /api/schedules` takes `{ message, day, time, timezone? }`.

`day` accepts either a calendar date (`2026-09-05`) or a weekday name
(`Monday`, `fri`), which resolves to its next occurrence — the brief says only
"day", so both readings are supported.

**Times resolve through an explicit IANA zone.** `new Date("2026-09-05T14:30:00")`
has no zone suffix and is parsed in the *server's* local zone, so the same
request means different instants on a laptop and in a container:

```
14:30 in UTC              → 2026-12-05T14:30:00.000Z
14:30 in Asia/Kolkata     → 2026-12-05T09:00:00.000Z
14:30 in America/New_York → 2026-12-05T19:30:00.000Z
```

Delivery runs in a worker thread (`workers/schedulerWorker.js`) that polls every
`SCHEDULER_POLL_INTERVAL_MS`. Each message is claimed with a single atomic
`findOneAndUpdate` (`pending` → `processing`), so the read and the claim are the
same operation and running several schedulers cannot double-deliver.

All state is in Mongo, which matters specifically because Task 2.1 restarts this
process: the thread dies with its worker and a replacement resumes from the same
collection. A claim abandoned mid-flight is released after
`SCHEDULER_CLAIM_TIMEOUT_MS`. An in-memory timer would drop every pending message
on each CPU restart.

Delivery precision is the poll interval — a message is delivered within
`SCHEDULER_POLL_INTERVAL_MS` of its due instant, never before.

---

## Configuration

Every knob is an environment variable; see `.env.example` for the full list with
defaults. The ones worth knowing:

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `MONGO_URI` | `mongodb://localhost:27017/policydb` | Connection string |
| `CLUSTER_WORKERS` | `1` | API workers behind the supervisor |
| `IMPORT_WORKERS` | `min(cpus-1, 4)` | Import thread pool size |
| `IMPORT_BATCH_SIZE` | `200` | Rows per bulkWrite batch |
| `CPU_THRESHOLD_PERCENT` | `70` | Restart threshold, % of one core |
| `CPU_SUSTAINED_SAMPLES` | `5` | Consecutive samples before tripping |
| `CPU_RESTART_DURING_IMPORT` | `false` | Allow restarts mid-import |
| `SCHEDULER_POLL_INTERVAL_MS` | `15000` | Delivery precision |
| `DEFAULT_TIMEZONE` | `UTC` | Zone used when a request omits one |
| `ENABLE_LOAD_ENDPOINT` | `true` | Exposes the CPU-burn demo endpoint |

---

## Tests

```bash
npm test
```

87 tests, no database required — `app.js` builds the Express app and nothing
else, so requiring it in a test does not open a connection or spawn threads.
Coverage is focused on the parts most likely to be wrong: the row → entity
mapping, timezone resolution, field normalisation, and request validation.

---

## Deploying on AWS, cheaply

The three moving parts here — the cluster supervisor, the import thread pool, and
the in-process scheduler — all need **one long-lived process**. That rules out
Lambda and API Gateway: a serverless invocation has no process for `cluster` to
restart, its timer dies when the response is sent, and a large import would
exceed the execution limit. Task 2.1 in particular is meaningless without a
persistent process.

So: the cheapest *compatible* option is a single small VM.

### Recommended shape

| Piece | Choice | Cost |
| ----- | ------ | ---- |
| Compute | EC2 **t4g.micro** (ARM/Graviton, 2 vCPU, 1 GB) | ~$6.13/mo — **$0 for 12 months** on a new account's free tier (750 h/mo of t3.micro) |
| Storage | 8 GB **gp3** EBS | ~$0.64/mo |
| Database | **MongoDB Atlas M0**, same AWS region | **$0** — 512 MB, free forever |
| TLS / ingress | **Caddy** on the instance, automatic Let's Encrypt | $0 |
| Egress | First 100 GB/mo free | $0 |
| **Total** | | **~$0 on free tier, ~$7/mo after** |

Graviton (`t4g`) is roughly 20% cheaper than `t3` for the same size, and
`node:20-alpine` has an arm64 image, so the Dockerfile works unchanged.

### What to avoid, and why

| Tempting | Why not |
| -------- | ------- |
| Application Load Balancer | ~$16–20/mo — **more than the server**. Terminate TLS with Caddy on the box instead. |
| ECS Fargate | ~$9/mo for 0.25 vCPU, and realistically pulls in an ALB. |
| App Runner | Bills provisioned memory even while idle; ~$5–25/mo. |
| DocumentDB | Minimum ~$200/mo. Atlas M0 is free and speaks the same protocol. |
| NAT Gateway | ~$32/mo. Put the instance in a public subnet with a security group. |
| Detailed CloudWatch monitoring | $2.10/instance/mo. Default 5-minute metrics are free. |
| ECR | Skip it — build the image on the instance and save the storage and transfer. |

### Cost-control specifics

1. **Set the T-instance to `standard` credit mode, not `unlimited`.** Burstable
   instances default to unlimited, which silently bills surplus CPU credits. This
   app deliberately spikes CPU during imports, so that surcharge is a real risk.
   Standard mode throttles instead of charging.
2. **Stop the instance when you are not demoing.** You then pay only for EBS
   (~$0.64/mo). For an assessment being reviewed over a few days, this is the
   single biggest saving.
3. **Attach an Elastic IP only while the instance runs** — it is free when
   attached to a running instance and billed when idle.
4. **Set a Budget alert at $5** (Billing → Budgets). Free, and it is the thing
   that catches a mistake before it compounds.
5. **Tune the pool for 1 GB of RAM.** Each import worker opens its own Mongoose
   pool. On a t4g.micro use `IMPORT_WORKERS=2` and `MONGO_WORKER_POOL_SIZE=3`;
   the defaults assume a larger box.
6. If you keep it beyond a year, a **1-year Compute Savings Plan** takes ~30–40%
   off, and **Spot** takes ~70% — the scheduler is DB-backed and idempotent, so
   an interruption is survivable.

### Deploy

```bash
# On a t4g.micro running Amazon Linux 2023
sudo dnf install -y docker git
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user && newgrp docker

git clone <your-repo> && cd policy-system

# Secrets as real environment variables — never a file in the image
cat > .env <<'EOF'
MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/policydb
NODE_ENV=production
CLUSTER_WORKERS=2
IMPORT_WORKERS=2
MONGO_WORKER_POOL_SIZE=3
ENABLE_LOAD_ENDPOINT=false
EOF

docker build -t policy-api .
docker run -d --name policy-api --restart unless-stopped \
  --env-file .env -p 127.0.0.1:4000:4000 policy-api

npm run indexes    # once, against the Atlas database
```

Then put Caddy in front for TLS (`caddy reverse-proxy --from api.example.com
--to 127.0.0.1:4000`), and open only 80/443 in the security group.

For Atlas, add the instance's Elastic IP to the M0 Network Access allowlist, and
pick the **same AWS region** as the EC2 instance to keep latency down.

> **Security group:** allow 80 and 443 from anywhere, 22 from your IP only.
> Do not expose 4000 publicly — the `-p 127.0.0.1:4000:4000` binding above keeps
> it on loopback so only Caddy can reach it.

### Alternative: Lightsail

A **$5/mo Lightsail instance** (1 GB, 40 GB SSD, 2 TB transfer) is a flat,
predictable bill with bandwidth included and no surprise line items. Slightly
more than a bare t4g.micro after free tier, and meaningfully simpler. If
predictability matters more than the last dollar, take this one.

---

## CI/CD

`.github/workflows/ci-cd.yml`

| Trigger | Test | Build image | Push to GHCR | Deploy |
| ------- | :--: | :---------: | :----------: | :----: |
| PR to `main` or `dev` | yes | yes | no | no |
| Push to `dev` | yes | yes | `dev-<sha>` | no |
| Push to `main` (a merged PR) | yes | yes | `main-<sha>` | **yes** |

The image is built on the runner, not on the instance. Runners are x86_64, the
same as the t3.micro, so it is a native build — and the earlier on-instance
builds are what filled that 6.7 GB disk to 100%. The instance only pulls.

**Deploy sequence.** Pull the new image, tag the outgoing one `previous`,
restart the container, then poll `/health` for up to 90 s. Because the app only
answers `/health` once Mongo is connected, that check also catches a bad
connection string or a lapsed Atlas allowlist entry. On failure it prints the
container logs, **rolls back to `previous`**, and fails the job. On success it
verifies `/health`, `/api-docs/` and an API route from the public internet.

**Secrets** (repository → Settings → Secrets and variables → Actions):

| Secret | Value |
| ------ | ----- |
| `EC2_HOST` | the instance's public IP |
| `EC2_USER` | `ubuntu` |
| `EC2_SSH_KEY` | private key of a **dedicated deploy keypair**, not your instance login key |

`GITHUB_TOKEN` is provided automatically and is what the instance uses to
authenticate to GHCR — it expires with the run, so no long-lived registry
credential is ever stored on the box.

**`MONGO_URI` is deliberately not a GitHub secret.** It lives in `.env` on the
instance at mode 600, and the workflow only swaps the image. The database
credential never enters CI. The trade-off is that a rebuilt instance needs its
`.env` recreated by hand.

To rotate the deploy key:

```bash
ssh-keygen -t ed25519 -N "" -C "github-actions-deploy" -f deploy_key
ssh ubuntu@<host> "echo '$(cat deploy_key.pub)' >> ~/.ssh/authorized_keys"
gh secret set EC2_SSH_KEY --repo <owner>/<repo> < deploy_key
rm -f deploy_key            # GitHub has it; nothing needs a local copy
```

Remove the old entry from `~/.ssh/authorized_keys` on the instance afterwards.

---

## Notes on the sample sheet

Things worth flagging to whoever produced the data:

- **47 emails are shared by two unrelated people each.** Handled by keying on
  `name + dob`; see above. Worth confirming this is a generation artefact.
- **Every user holds exactly one policy**, so per-user aggregation is
  1:1 on this data. The API is general; the dataset is flat.
- **Five account names belong to two different people** (`"Lura Lucca & Owen
  Dodson"` is shared by *Lura Lucca* and *High Low*), so accounts are keyed on
  `(name, owner)`.
- **`firstname` holds full names** ("Lura Lucca"), not first names. Search matches
  on the whole field.
- **Five columns are empty in all 1,198 rows** — `premium_amount_written`,
  `primary`, `Applicant ID`, `agency_id`, `hasActive ClientPolicy` — and are not
  imported.
- **18 rows have no address, city, state or zip**; those fields are omitted
  rather than stored as empty strings. 463 rows have no gender.
- **`userType` is `"Active Client"` on every row.**

Two questions the brief leaves open, which I resolved by supporting both readings:

1. **"day"** in the schedule payload — calendar date or weekday name? Both work.
2. **"username"** — the sheet has no username column; `firstname` is the closest
   and is unique, so search matches that (and email, if the term looks like one).

---

## Project layout

```
config/           environment parsing, one place
db/connect.js     Mongoose connection
models/           the six collections + importjobs, scheduledposts, posts
routes/           upload, policy, schedule, system
services/         importRunner — owns the worker pool and the job document
workers/          importWorker (pool member), schedulerWorker (delivery loop)
utils/            ids, normalize, transform, rowSource, datetime, cpuMonitor, logger
scripts/          syncIndexes
tests/            87 tests, no database needed
```
