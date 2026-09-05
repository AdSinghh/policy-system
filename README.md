# Policy Management API

A production-oriented Node.js backend for managing insurance policy data at scale.

The system imports large CSV/XLSX insurance datasets into MongoDB using parallel worker threads, provides policy search and per-user analytics, supports scheduled message delivery, and includes a CPU-aware process supervisor that can gracefully recycle overloaded API workers.

> **Backend only.** There is no frontend in this repository.

---

## 🚀 What This Project Does

The system is designed around a common insurance-platform workflow:

```text
Insurance CSV / XLSX
        │
        ▼
   Upload API
        │
        ▼
   Import Job
        │
        ▼
 Worker Thread Pool
   ┌────┼────┐
   ▼    ▼    ▼
  W1   W2   W3 ...
   │    │    │
   └────┼────┘
        ▼
 MongoDB Bulk Writes
        │
        ├──────────────┐
        ▼              ▼
   Policy APIs     Aggregation APIs
        │
        ▼
 Scheduled Messaging
```

The system focuses on several backend engineering concerns:

* Large-file ingestion
* Parallel processing
* MongoDB bulk operations
* Idempotent imports
* Natural-key based data modelling
* Search and pagination
* Aggregation pipelines
* Concurrent message claiming
* Timezone-aware scheduling
* CPU monitoring
* Graceful worker replacement
* Docker deployment
* CI/CD

---

## ✨ Key Features

### 1. Parallel CSV/XLSX Import

Large policy files are processed asynchronously using Node.js worker threads.

The API immediately returns an import job ID instead of keeping the HTTP request open while the entire file is processed.

```text
POST /api/upload

        │
        ▼
 Save uploaded file
        │
        ▼
 Create ImportJob
        │
        ▼
 Return HTTP 202
        │
        ▼
 Worker pool processes file
```

The default import worker count is:

```text
min(number_of_CPUs - 1, 4)
```

Each worker processes a deterministic subset of rows:

```text
rowIndex % workerCount === workerIndex
```

This allows multiple workers to process the same file without requiring a central queue for individual rows.

---

### 2. Batch MongoDB Writes

Rows are accumulated into batches before being written to MongoDB.

Default:

```text
IMPORT_BATCH_SIZE = 200
```

Instead of doing:

```text
row → insert
row → insert
row → insert
...
```

the system performs MongoDB `bulkWrite` operations.

```text
200 rows
   │
   ├── agents
   ├── users
   ├── accounts
   ├── categories
   ├── carriers
   └── policies
          │
          ▼
     bulkWrite()
```

This significantly reduces database round trips.

---

### 3. Idempotent Imports

The same dataset can be uploaded multiple times without creating duplicate records.

Document IDs are deterministically generated from natural keys.

Conceptually:

```text
natural key
     │
     ▼
   SHA-1
     │
     ▼
 deterministic MongoDB _id
```

Therefore:

```text
Upload #1
    ↓
Policy A → ID X

Upload #2
    ↓
Policy A → ID X

Upload #3
    ↓
Policy A → ID X
```

The same logical entity always maps to the same document.

This also means import workers do not need to coordinate with one another merely to create shared entities.

---

## 🧠 Data Modelling

The system uses six primary collections:

```text
Agent
Carrier
Category
    │
    ├──────────┐
    │          │
    ▼          ▼
             Policy
                │
                ▼
              User
                │
                ▼
             Account
```

Supporting collections are used for asynchronous operations:

```text
ImportJob
ScheduledPost
Post
```

### Collections

| Collection       | Purpose                    | Natural Key            |
| ---------------- | -------------------------- | ---------------------- |
| `agents`         | Insurance agents/producers | `nameKey`              |
| `users`          | Policy holders             | `name + dob`           |
| `accounts`       | User accounts              | `accountName + userId` |
| `categories`     | Lines of business          | `categoryNameKey`      |
| `carriers`       | Insurance carriers         | `companyNameKey`       |
| `policies`       | Insurance policies         | `policy_number`        |
| `importjobs`     | Import progress/state      | Job ID                 |
| `scheduledposts` | Pending messages           | Message ID             |
| `posts`          | Delivered messages         | Message ID             |

---

## Why `name + DOB` Is Used Instead of Email

One of the important data-quality problems in the supplied dataset is that multiple unrelated people share the same email address.

Using email as the user identifier would incorrectly merge different people.

The dataset contains:

```text
1,198 rows

Email-based users:
1,149

Users lost through email collisions:
49
```

Using:

```text
name + date of birth
```

preserves all 1,198 users.

Therefore the system uses:

```text
userKey = normalizedName + "|" + dateOfBirth
```

rather than email.

This is an important example of why **business identity and contact information are not always the same thing**.

---

# 🔄 Import Flow

The complete upload flow is:

```text
Client
  │
  │ POST /api/upload
  ▼
Express Route
  │
  ├── Validate file
  │
  ├── Store uploaded file
  │
  └── Create ImportJob
          │
          ▼
      HTTP 202
          │
          │ jobId
          ▼
    Import Runner
          │
          ▼
    Worker Thread Pool
       ┌──┼──┐
       ▼  ▼  ▼
      W1 W2 W3
       │  │  │
       └──┼──┘
          ▼
     Transform Rows
          │
          ▼
     Batch Documents
          │
          ▼
    MongoDB bulkWrite
          │
          ▼
     Update ImportJob
          │
          ▼
       completed
```

The API does not wait for the import to finish.

Instead:

```http
HTTP/1.1 202 Accepted
```

is returned with a job ID.

The client can then poll:

```http
GET /api/imports/:jobId
```

to retrieve progress.

---

# 🔍 Policy Search

Policies can be searched using:

```http
GET /api/policies/search?username=Lura%20Lucca
```

The search:

1. Normalizes the search term.
2. Escapes user-provided input.
3. Performs a prefix search.
4. Resolves the associated user.
5. Resolves carrier, category, account, and agent.
6. Applies pagination.

If the search term looks like an email address, the email field is used.

Example:

```text
username=Lura Lucca
        ↓
nameKey prefix search
```

or:

```text
username=user@example.com
        ↓
emailKey search
```

---

# 📊 Per-User Aggregation

The API provides aggregated policy information:

```http
GET /api/policies/aggregate-by-user
```

It can calculate:

* Number of policies
* Total premium
* Policy coverage date range
* User information
* Optional policy details

Example:

```http
GET /api/policies/aggregate-by-user?limit=5&includePolicies=true
```

MongoDB aggregation stages are structured so pagination happens before expensive joins where possible.

Conceptually:

```text
$group
   │
   ▼
$sort
   │
   ▼
$skip
   │
   ▼
$limit
   │
   ▼
$lookup
   │
   ▼
Response
```

This prevents the database from unnecessarily joining records that will eventually be discarded by pagination.

---

# ⏰ Scheduled Messaging

The system supports scheduled messages through:

```http
POST /api/schedules
```

Example:

```json
{
  "message": "Renewal reminder",
  "day": "2026-09-05",
  "time": "14:30",
  "timezone": "Asia/Kolkata"
}
```

The scheduler supports:

* Calendar dates
* Weekday names
* IANA timezones
* Persistent message state
* Retry/recovery after process restart

---

# 🔐 Concurrent Message Claiming

A major reliability concern with schedulers is duplicate delivery.

A naive implementation might do:

```text
Worker A                  Worker B

find pending message      find pending message
       │                         │
       ▼                         ▼
same message              same message
       │                         │
       ▼                         ▼
send                     send
```

This can result in duplicate messages.

Instead, this project atomically changes the state:

```text
pending
   │
   │ atomic findOneAndUpdate
   ▼
processing
   │
   ▼
delivered
```

The important operation is:

```text
findOneAndUpdate()
```

with the state transition occurring atomically.

Therefore, when multiple scheduler workers run concurrently, only one worker successfully claims a particular pending message.

This is a classic database-level concurrency-control pattern.

---

# 🖥️ CPU Watchdog

The application contains a process supervisor that monitors API-worker CPU utilization.

The configured threshold is:

```text
CPU_THRESHOLD_PERCENT=70
```

CPU is sampled periodically.

A single spike does not immediately restart the worker.

Instead, the system requires consecutive samples above the threshold:

```text
CPU:

50%
65%
72%  ← above threshold
81%  ← above threshold
95%  ← above threshold
99%  ← above threshold
98%  ← above threshold
       │
       ▼
   restart worker
```

Default:

```text
CPU_SUSTAINED_SAMPLES=5
```

This prevents a short CPU spike from causing unnecessary worker restarts.

---

# ♻️ Graceful Worker Restart

When a worker exceeds the CPU threshold for the required number of samples:

```text
CPU threshold exceeded
          │
          ▼
Supervisor requests shutdown
          │
          ▼
Stop accepting new requests
          │
          ▼
Finish in-flight requests
          │
          ▼
Close MongoDB connection
          │
          ▼
Worker exits
          │
          ▼
Supervisor forks replacement
          │
          ▼
New worker starts
```

A forced `SIGKILL` is only used if graceful shutdown exceeds the configured timeout.

---

# 🚫 Import-Aware CPU Monitoring

A large import can legitimately consume significant CPU.

Restarting the worker simply because CPU reached 70% during an import could destroy the import midway.

Therefore the system communicates import state to the supervisor.

```text
CPU = 99%

       │
       ▼
Is import running?
       │
   ┌───┴───┐
   │       │
  YES      NO
   │        │
   ▼        ▼
Suppress  Restart
restart
```

This prevents the CPU watchdog from killing a legitimate long-running import.

---

# 🧱 High-Level Architecture

```text
                         ┌─────────────────┐
                         │      Client     │
                         └────────┬────────┘
                                  │
                                  ▼
                         ┌─────────────────┐
                         │    Express API  │
                         └────────┬────────┘
                                  │
             ┌────────────────────┼────────────────────┐
             │                    │                    │
             ▼                    ▼                    ▼
       Upload Routes        Policy Routes       Schedule Routes
             │                    │                    │
             ▼                    ▼                    ▼
       Import Runner         Aggregation         Scheduler
             │                    │                    │
             ▼                    ▼                    ▼
      Worker Threads          MongoDB             Worker Thread
             │                    │                    │
             └────────────────────┼────────────────────┘
                                  │
                                  ▼
                            ┌─────────────┐
                            │   MongoDB   │
                            └─────────────┘

                    ┌─────────────────────────┐
                    │ CPU Supervisor / Cluster│
                    └────────────┬────────────┘
                                 │
                         monitors API worker
                                 │
                                 ▼
                         graceful replacement
```

---

# 📡 API Endpoints

| Method | Endpoint                          | Purpose                       |
| ------ | --------------------------------- | ----------------------------- |
| `POST` | `/api/upload`                     | Upload CSV/XLSX policy data   |
| `GET`  | `/api/imports/:jobId`             | Get import status             |
| `GET`  | `/api/policies/search`            | Search policies               |
| `GET`  | `/api/policies/aggregate-by-user` | Aggregate policies by user    |
| `POST` | `/api/schedules`                  | Create scheduled message      |
| `POST` | `/api/system/load`                | Generate CPU load for testing |
| `GET`  | `/health`                         | Health check                  |
| `GET`  | `/api-docs`                       | Swagger API documentation     |

---

# 📁 Project Structure

```text
policy-system/
│
├── config/
│   └── Environment configuration
│
├── db/
│   └── MongoDB connection
│
├── models/
│   ├── Agent
│   ├── User
│   ├── Account
│   ├── Category
│   ├── Carrier
│   ├── Policy
│   ├── ImportJob
│   ├── ScheduledPost
│   └── Post
│
├── routes/
│   ├── Upload routes
│   ├── Policy routes
│   ├── Schedule routes
│   └── System routes
│
├── services/
│   └── importRunner.js
│
├── workers/
│   ├── importWorker.js
│   └── schedulerWorker.js
│
├── utils/
│   ├── ids.js
│   ├── normalize.js
│   ├── transform.js
│   ├── rowSource.js
│   ├── datetime.js
│   ├── cpuMonitor.js
│   └── logger.js
│
├── scripts/
│   └── syncIndexes
│
├── tests/
│
├── uploads/
│
├── app.js
├── server.js
├── Dockerfile
├── docker-compose.yml
├── swagger.json
├── package.json
└── README.md
```

---

# 🛠️ Tech Stack

| Technology     | Purpose                       |
| -------------- | ----------------------------- |
| Node.js        | Backend runtime               |
| Express        | REST API                      |
| MongoDB        | Primary database              |
| Mongoose       | MongoDB ODM                   |
| Worker Threads | Parallel CPU-bound processing |
| Cluster        | API worker supervision        |
| Docker         | Containerization              |
| Docker Compose | Local development             |
| Swagger        | API documentation             |
| GitHub Actions | CI/CD                         |
| AWS EC2        | Deployment                    |
| MongoDB Atlas  | Managed database              |

---

# 🚀 Getting Started

## Prerequisites

Install:

* Node.js
* npm
* MongoDB

or use Docker.

---

## Option 1: Docker

Clone the repository:

```bash
git clone https://github.com/AdSinghh/policy-system.git

cd policy-system
```

Create environment configuration:

```bash
cp .env.example .env
```

Start the application:

```bash
docker compose up --build
```

The services will be available at:

```text
API:    http://localhost:4000
Mongo:  localhost:27017
Swagger: http://localhost:4000/api-docs
```

---

## Option 2: Local Node.js

Install dependencies:

```bash
npm install
```

Configure MongoDB:

```bash
export MONGO_URI="mongodb://localhost:27017/policydb"
```

Create indexes:

```bash
npm run indexes
```

Start the server:

```bash
npm start
```

---

# 🧪 Testing

Run:

```bash
npm test
```

The project contains automated tests covering important areas such as:

* Row transformation
* Field normalization
* Timezone resolution
* Request validation
* Import-related logic

The Express application is separated from process startup so tests can load the application without opening database connections or spawning workers.

---

# 🧪 Example API Usage

### Upload a policy file

```bash
curl -X POST \
  http://localhost:4000/api/upload \
  -F "file=@data-sheet.csv"
```

Response:

```json
{
  "jobId": "6a9482...",
  "status": "queued",
  "statusUrl": "/api/imports/6a9482..."
}
```

---

### Check import status

```bash
curl \
  http://localhost:4000/api/imports/6a9482...
```

---

### Search policies

```bash
curl --get \
  http://localhost:4000/api/policies/search \
  --data-urlencode "username=Lura Lucca"
```

---

### Aggregate policies

```bash
curl \
  "http://localhost:4000/api/policies/aggregate-by-user?limit=5&includePolicies=true"
```

---

### Schedule a message

```bash
curl -X POST \
  http://localhost:4000/api/schedules \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Renewal reminder",
    "day": "2026-09-05",
    "time": "14:30",
    "timezone": "Asia/Kolkata"
  }'
```

---

# ⚙️ Important Configuration

| Variable                     |           Default | Description                           |
| ---------------------------- | ----------------: | ------------------------------------- |
| `MONGO_URI`                  | localhost MongoDB | MongoDB connection string             |
| `CLUSTER_WORKERS`            |               `1` | Number of API workers                 |
| `IMPORT_WORKERS`             |   `min(cpus-1,4)` | Import worker threads                 |
| `IMPORT_BATCH_SIZE`          |             `200` | Rows per MongoDB batch                |
| `CPU_THRESHOLD_PERCENT`      |              `70` | CPU restart threshold                 |
| `CPU_SUSTAINED_SAMPLES`      |               `5` | Required consecutive high-CPU samples |
| `CPU_RESTART_DURING_IMPORT`  |           `false` | Allow restart during imports          |
| `SCHEDULER_POLL_INTERVAL_MS` |           `15000` | Scheduler polling interval            |
| `DEFAULT_TIMEZONE`           |             `UTC` | Default timezone                      |
| `ENABLE_LOAD_ENDPOINT`       |            `true` | Enable CPU testing endpoint           |

---

# 🐳 Docker

Build:

```bash
docker build -t policy-api .
```

Run:

```bash
docker run \
  --name policy-api \
  --restart unless-stopped \
  --env-file .env \
  -p 4000:4000 \
  policy-api
```

For production, MongoDB credentials should be provided through environment configuration or a secret-management system rather than being baked into the image.

---

# ☁️ AWS Deployment

The application is designed around a long-running process because several features depend on process lifetime:

* Cluster supervision
* Worker threads
* CPU monitoring
* Scheduler polling
* Large imports

Therefore a small VM-based deployment is a better fit than a purely serverless architecture for this implementation.

Example architecture:

```text
                    Internet
                       │
                       ▼
                ┌─────────────┐
                │    Caddy    │
                │ TLS / HTTPS │
                └──────┬──────┘
                       │
                       ▼
                ┌─────────────┐
                │   AWS EC2   │
                │             │
                │ Docker      │
                │   │         │
                │   ▼         │
                │ Node API    │
                └──────┬──────┘
                       │
                       │ TLS
                       ▼
                ┌─────────────┐
                │ Mongo Atlas │
                └─────────────┘
```

Recommended security-group configuration:

```text
80   → Internet
443  → Internet
22   → Your IP only
4000 → NOT publicly exposed
```

The Node.js application should listen behind the reverse proxy rather than exposing the application port directly to the internet.

---

# 🔄 CI/CD

GitHub Actions handles:

```text
Pull Request
     │
     ▼
Run tests
     │
     ▼
Build Docker image
```

For `dev`:

```text
Push
 │
 ▼
Test
 │
 ▼
Build
 │
 ▼
Push image
```

For `main`:

```text
Push / Merge
     │
     ▼
Run tests
     │
     ▼
Build Docker image
     │
     ▼
Push image to GHCR
     │
     ▼
Deploy to EC2
     │
     ▼
Health check
     │
 ┌───┴────┐
 │        │
PASS     FAIL
 │        │
 ▼        ▼
Done    Rollback
```

The deployment process verifies the application's health before considering the deployment successful.

---

# 📈 Performance

The supplied sample contains 1,198 rows.

With four import workers and local MongoDB, the measured import completes in approximately:

```text
1,198 rows
4 workers
≈ 1.3 seconds
```

A larger 14,376-row file was processed in approximately:

```text
14,376 rows
4 workers
≈ 11.2 seconds
```

These numbers are environment-dependent and should be treated as benchmark observations rather than guaranteed production throughput.

---

# 🧩 Important Engineering Decisions

## Why Worker Threads?

CSV/XLSX parsing and transformation can involve CPU-heavy work.

Running everything on the main Node.js event loop can block request handling.

Worker threads allow the application to move CPU-intensive processing away from the API worker.

```text
Without workers:

HTTP requests
     │
     ▼
Main Node Thread
     │
     ├── API
     ├── CSV parsing
     ├── transformation
     └── MongoDB work

Large import
     │
     ▼
Event loop becomes busy
```

With workers:

```text
API Worker
    │
    ├── HTTP requests
    └── API operations

Import Workers
    │
    ├── Parse
    ├── Transform
    └── Bulk write
```

---

## Why Bulk Writes?

Without batching:

```text
10,000 rows
     ↓
potentially thousands of DB operations
```

With batching:

```text
10,000 rows
     ↓
50 × 200-row batches
     ↓
bulkWrite()
```

This dramatically reduces network round trips.

---

## Why Deterministic IDs?

Without deterministic IDs:

```text
Upload #1 → ObjectId A
Upload #2 → ObjectId B
Upload #3 → ObjectId C
```

The same logical policy could create multiple documents.

With deterministic IDs:

```text
Policy key
    ↓
SHA-1
    ↓
same _id
```

Therefore repeated imports converge on the same records.

---

## Why Atomic Message Claiming?

Because:

```text
find()
+
update()
```

are separate operations and can race.

Instead:

```text
findOneAndUpdate()
```

performs the selection and state transition atomically.

This makes the database the synchronization mechanism between scheduler workers.

---

# 🎯 Interview Explanation

If asked:

### "Explain this project."

A strong answer is:

> "I built a Node.js backend for an insurance policy management system. The main challenge was processing potentially large CSV and XLSX files efficiently without blocking the API. I designed the upload flow to be asynchronous. The API stores the file, creates an import job, returns a 202 response with a job ID, and then a pool of worker threads processes the file in parallel.
>
> Each worker processes a deterministic subset of rows and accumulates them into batches. Instead of performing individual MongoDB operations for every row, it uses bulk writes to reduce database round trips.
>
> I also designed the data model around natural keys and deterministic IDs so that imports are idempotent. Uploading the same file multiple times updates the same documents instead of creating duplicates.
>
> Apart from imports, the system provides policy search and MongoDB aggregation APIs. It also has a scheduler for sending messages at a specific time. To prevent duplicate delivery when multiple scheduler workers are running, messages are claimed using an atomic MongoDB find-and-update operation.
>
> Finally, I implemented a CPU watchdog using a cluster supervisor. If an API worker stays above the CPU threshold for several consecutive samples, the supervisor gracefully drains and replaces that worker. Imports are detected separately so legitimate CPU-heavy imports aren't accidentally killed.
>
> The application is containerized with Docker and has a GitHub Actions CI/CD pipeline for testing, building, publishing, and deploying the application."

---

# 🔥 Interview Topics Covered

This project gives you opportunities to discuss:

### Node.js

* Event loop
* Worker threads
* Cluster
* Graceful shutdown
* Process supervision
* CPU-bound work

### MongoDB

* Indexes
* Bulk writes
* Aggregation
* `$lookup`
* `$group`
* `$facet`
* Atomic updates
* Natural keys
* Idempotency

### Distributed Systems Concepts

* Race conditions
* Idempotency
* Concurrent consumers
* State machines
* Persistent queues
* Worker recovery
* Retry/recovery
* Failure handling

### System Design

* Asynchronous processing
* Background workers
* Job tracking
* Horizontal workers
* Database-backed scheduling
* Health checks
* Graceful deployments

### DevOps

* Docker
* Docker Compose
* AWS EC2
* MongoDB Atlas
* Reverse proxy
* GitHub Actions
* Container registry
* Deployment rollback

---

# ⚠️ Production Considerations

For a larger production deployment, several components could be evolved further.

### Message Delivery

The current scheduler provides persistent claiming and recovery.

For very high message volume, a dedicated queue such as Kafka, RabbitMQ, SQS, or BullMQ could provide stronger throughput and operational isolation.

### Import Processing

For very large datasets, imports could move from local file storage to object storage such as S3.

```text
Client
  │
  ▼
S3
  │
  ▼
Import Queue
  │
  ▼
Worker Fleet
  │
  ▼
MongoDB
```

### Observability

A production deployment could additionally include:

* Prometheus metrics
* Grafana dashboards
* Distributed tracing
* Structured logs
* Error tracking
* Import throughput metrics
* Queue depth metrics
* Worker health metrics

### Scaling

The current architecture can evolve from:

```text
Single EC2
    │
    └── Node.js
```

to:

```text
                Load Balancer
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
       API-1      API-2      API-3
          │          │          │
          └──────────┼──────────┘
                     │
                  MongoDB
                     │
              ┌──────┴──────┐
              ▼             ▼
          Import Pool   Scheduler
```

---

# 📌 Project Status

This repository demonstrates a backend-focused implementation of an insurance policy management system with emphasis on:

```text
Reliable ingestion
       +
Parallel processing
       +
Database correctness
       +
Concurrency control
       +
Background processing
       +
Process supervision
       +
Containerized deployment
```

---

## License

Add the appropriate license for your project here.
