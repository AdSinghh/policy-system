const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const config = require("../config");
const logger = require("../utils/logger");
const ImportJob = require("../models/ImportJob");
const { runImport } = require("../services/importRunner");

const router = express.Router();

fs.mkdirSync(config.import.uploadDir, { recursive: true });

const ALLOWED_EXTENSIONS = new Set([".csv", ".xlsx", ".xlsm"]);

const upload = multer({
  dest: config.import.uploadDir,
  limits: { fileSize: config.import.maxFileSizeMb * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    if (ALLOWED_EXTENSIONS.has(extension)) return cb(null, true);
    cb(
      new Error(
        `Unsupported file type '${extension || "unknown"}'. Upload .csv, .xlsx or .xlsm.`,
      ),
    );
  },
});

/**
 * POST /api/upload  (also mounted at /api/imports)
 *
 * Accepts a CSV or XLSX file and answers 202 with a job id. The parse itself runs
 * on a pool of worker threads; poll GET /api/imports/:id to follow it.
 */
router.post("/", (req, res) => {
  upload.single("file")(req, res, async (uploadError) => {
    if (uploadError) {
      const tooLarge = uploadError.code === "LIMIT_FILE_SIZE";
      logger.warn("Upload rejected: %s", uploadError.message);
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge
          ? `File exceeds the ${config.import.maxFileSizeMb} MB limit.`
          : uploadError.message,
      });
    }

    if (!req.file) {
      return res
        .status(400)
        .json({ error: "No file uploaded. Send multipart/form-data with a 'file' field." });
    }

    try {
      const job = await ImportJob.create({
        originalName: req.file.originalname,
        storedPath: req.file.path,
        sizeBytes: req.file.size,
        status: "queued",
      });

      // Deliberately not awaited: the pool outlives this request. Failures are
      // recorded on the job document, which is what the client polls.
      runImport(job).catch((err) =>
        logger.error("Unhandled import failure %s: %s", job._id, err.message),
      );

      logger.info(
        "Import %s queued (%s, %d bytes)",
        job._id,
        req.file.originalname,
        req.file.size,
      );

      res.status(202).json({
        jobId: job._id,
        status: job.status,
        originalName: job.originalName,
        statusUrl: `/api/imports/${job._id}`,
      });
    } catch (err) {
      logger.error("Failed to queue import: %s", err.message);
      res.status(500).json({ error: "Could not queue the import." });
    }
  });
});

/** GET /api/imports — recent jobs, newest first. */
router.get("/", async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || "20", 10)));
  try {
    const jobs = await ImportJob.find()
      .sort({ createdAt: -1 })
      .limit(limit)
      .select("-storedPath")
      .lean();
    res.json({ jobs });
  } catch (err) {
    logger.error("Failed to list imports: %s", err.message);
    res.status(500).json({ error: "Could not list import jobs." });
  }
});

/** GET /api/imports/:id — progress and outcome for one job. */
router.get("/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({ error: "Not a valid job id." });
  }

  try {
    const job = await ImportJob.findById(req.params.id).select("-storedPath").lean();
    if (!job) return res.status(404).json({ error: "Import job not found." });
    res.json(job);
  } catch (err) {
    logger.error("Failed to read import job: %s", err.message);
    res.status(500).json({ error: "Could not read the import job." });
  }
});

module.exports = router;
