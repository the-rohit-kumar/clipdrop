const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads dir exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// In-memory OTP store: { otp -> { filePath, originalName, mimetype, size, expiresAt } }
const otpStore = new Map();
const OTP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Multer config — store on disk with random filename
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const unique = crypto.randomBytes(16).toString('hex');
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB max
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Generate a unique 4-digit OTP not already in use
function generateOTP() {
  let otp;
  let attempts = 0;
  do {
    otp = String(Math.floor(1000 + Math.random() * 9000));
    attempts++;
    if (attempts > 100) throw new Error('OTP space exhausted');
  } while (otpStore.has(otp));
  return otp;
}

// Cleanup expired entries every 10 minutes
function cleanupExpired() {
  const now = Date.now();
  for (const [otp, entry] of otpStore.entries()) {
    if (entry.expiresAt < now) {
      fs.unlink(entry.filePath, () => {});
      otpStore.delete(otp);
      console.log(`Expired OTP ${otp} cleaned up`);
    }
  }
}
setInterval(cleanupExpired, 10 * 60 * 1000);

// POST /api/upload — accept a file, return OTP
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided.' });

  let otp;
  try {
    otp = generateOTP();
  } catch (e) {
    fs.unlink(req.file.path, () => {});
    return res.status(503).json({ error: 'Could not generate OTP. Try again.' });
  }

  otpStore.set(otp, {
    filePath: req.file.path,
    originalName: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    expiresAt: Date.now() + OTP_TTL_MS
  });

  console.log(`Uploaded: ${req.file.originalname} → OTP ${otp}`);
  res.json({ otp, expiresInHours: 24 });
});

// GET /api/info/:otp — check if OTP exists and return file metadata
app.get('/api/info/:otp', (req, res) => {
  const entry = otpStore.get(req.params.otp);
  if (!entry) return res.status(404).json({ error: 'Invalid or expired OTP.' });
  if (entry.expiresAt < Date.now()) {
    fs.unlink(entry.filePath, () => {});
    otpStore.delete(req.params.otp);
    return res.status(404).json({ error: 'OTP has expired.' });
  }
  res.json({
    name: entry.originalName,
    size: entry.size,
    mimetype: entry.mimetype,
    expiresAt: entry.expiresAt
  });
});

// GET /api/download/:otp — stream the file to the client
app.get('/api/download/:otp', (req, res) => {
  const entry = otpStore.get(req.params.otp);
  if (!entry) return res.status(404).json({ error: 'Invalid or expired OTP.' });
  if (entry.expiresAt < Date.now()) {
    fs.unlink(entry.filePath, () => {});
    otpStore.delete(req.params.otp);
    return res.status(404).json({ error: 'OTP has expired.' });
  }
  if (!fs.existsSync(entry.filePath)) {
    otpStore.delete(req.params.otp);
    return res.status(404).json({ error: 'File no longer available.' });
  }

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(entry.originalName)}"`);
  res.setHeader('Content-Type', entry.mimetype || 'application/octet-stream');
  res.setHeader('Content-Length', entry.size);
  fs.createReadStream(entry.filePath).pipe(res);
});

/* ============================================================================
 * LARGE FILE TRANSFER — additive feature
 * ----------------------------------------------------------------------------
 * The 50 MB ClipDrop flow above is left exactly as it was: this feature has
 * its own routes (/api/big/*), its own folder (uploads/big), its own in-memory
 * store and its own 6-digit codes, so the two can never interfere.
 * ========================================================================== */
const BIG_DIR = path.join(UPLOADS_DIR, 'big');
if (!fs.existsSync(BIG_DIR)) fs.mkdirSync(BIG_DIR, { recursive: true });

const BIG_MAX_GB = Number(process.env.BIG_MAX_GB) || 20;     // per-file cap
const BIG_TOTAL_GB = Number(process.env.BIG_TOTAL_GB) || 60; // folder cap
const BIG_MAX_BYTES = Math.round(BIG_MAX_GB * 1024 * 1024 * 1024);
const BIG_TOTAL_BYTES = Math.round(BIG_TOTAL_GB * 1024 * 1024 * 1024);
const BIG_TTL_MS = OTP_TTL_MS; // same 24-hour retention as ClipDrop

// In-memory code store: { code -> { filePath, originalName, mimetype, size, expiresAt } }
const bigStore = new Map();
let bigUsedBytes = 0;

const bigStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, BIG_DIR),
  filename: (req, file, cb) => {
    const unique = crypto.randomBytes(16).toString('hex');
    cb(null, unique + path.extname(file.originalname));
  }
});
const bigUploader = multer({
  storage: bigStorage,
  limits: { fileSize: BIG_MAX_BYTES, files: 1 }
});

function bigLimitLabel(gb) {
  return (Number.isInteger(gb) ? String(gb) : gb.toFixed(1)) + ' GB';
}

// 6-digit codes: 1,000,000 combinations and visually distinct from the
// 4-digit ClipDrop codes, so a code is never ambiguous between the two modes.
function generateBigCode() {
  let code;
  let attempts = 0;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
    attempts++;
    if (attempts > 500) throw new Error('large-transfer code space exhausted');
  } while (bigStore.has(code));
  return code;
}

function bigDelete(code) {
  const entry = bigStore.get(code);
  if (!entry) return;
  bigUsedBytes = Math.max(0, bigUsedBytes - entry.size);
  bigStore.delete(code);
  fs.unlink(entry.filePath, () => {});
}

function bigRecomputeUsage() {
  fs.readdir(BIG_DIR, (err, names) => {
    if (err) return;
    if (names.length === 0) {
      bigUsedBytes = 0;
      return;
    }
    let total = 0;
    let pending = names.length;
    for (const name of names) {
      fs.stat(path.join(BIG_DIR, name), (e, st) => {
        if (!e && st.isFile()) total += st.size;
        if (--pending === 0) bigUsedBytes = total;
      });
    }
  });
}

// Delete files in uploads/big that no code points to and that are older than
// the retention window (e.g. left behind by a crash), mirroring ClipDrop's 24 h
// auto-delete behaviour.
function bigSweepOrphans() {
  const referenced = new Set([...bigStore.values()].map((e) => path.basename(e.filePath)));
  fs.readdir(BIG_DIR, (err, names) => {
    if (err) return;
    for (const name of names) {
      if (referenced.has(name)) continue;
      const filePath = path.join(BIG_DIR, name);
      fs.stat(filePath, (e, st) => {
        if (e || !st.isFile()) return;
        if (Date.now() - st.mtimeMs >= BIG_TTL_MS) {
          fs.unlink(filePath, () => bigRecomputeUsage());
        }
      });
    }
  });
}

function bigCleanupExpired() {
  const now = Date.now();
  for (const code of [...bigStore.keys()]) {
    const entry = bigStore.get(code);
    if (entry && entry.expiresAt < now) {
      bigDelete(code);
      console.log(`Large transfer ${code} expired and was cleaned up`);
    }
  }
  bigSweepOrphans();
}
setInterval(bigCleanupExpired, 10 * 60 * 1000);
bigRecomputeUsage();

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', files: otpStore.size }));

// Limit/size errors for this feature are answered here as JSON, so the original
// /api/upload error behaviour is left untouched.
const bigUpload = (req, res, next) => {
  bigUploader.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File too large. Max ${bigLimitLabel(BIG_MAX_GB)} per file.` });
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: 'Send one file at a time.' });
      }
      return res.status(400).json({ error: err.message });
    }
    console.error('Large upload failed:', err.message);
    res.status(500).json({ error: 'Upload failed.' });
  });
};

// Reject oversized uploads from the Content-Length header, before gigabytes get
// written to disk.
function bigCheckQuota(req, res, next) {
  const declared = Number(req.headers['content-length']) || 0;
  if (declared > BIG_MAX_BYTES + 1024 * 1024) {
    return res.status(413).json({ error: `File too large. Max ${bigLimitLabel(BIG_MAX_GB)} per file.` });
  }
  if (declared > 0 && bigUsedBytes + declared > BIG_TOTAL_BYTES) {
    return res.status(507).json({
      error: `Large-transfer storage is full (${bigLimitLabel(BIG_TOTAL_GB)}). Wait for the 24 h expiry to free space.`
    });
  }
  next();
}

// GET /api/big/config — limits for the UI
app.get('/api/big/config', (req, res) => {
  res.json({
    maxFileBytes: BIG_MAX_BYTES,
    maxFileLabel: bigLimitLabel(BIG_MAX_GB),
    maxTotalBytes: BIG_TOTAL_BYTES,
    maxTotalLabel: bigLimitLabel(BIG_TOTAL_GB),
    retentionHours: 24
  });
});

// POST /api/big/upload — accept a large file, return a 6-digit code
app.post('/api/big/upload', bigCheckQuota, bigUpload, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided.' });

  if (bigUsedBytes + req.file.size > BIG_TOTAL_BYTES) {
    fs.unlink(req.file.path, () => {});
    return res.status(507).json({
      error: `Large-transfer storage is full (${bigLimitLabel(BIG_TOTAL_GB)}).`
    });
  }

  let code;
  try {
    code = generateBigCode();
  } catch (e) {
    fs.unlink(req.file.path, () => {});
    return res.status(503).json({ error: 'Could not generate a code. Try again.' });
  }

  bigStore.set(code, {
    filePath: req.file.path,
    originalName: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size,
    expiresAt: Date.now() + BIG_TTL_MS
  });
  bigUsedBytes += req.file.size;

  console.log(`Large upload: ${req.file.originalname} (${req.file.size} bytes) → code ${code}`);
  res.json({
    code,
    expiresInHours: 24,
    maxFileBytes: BIG_MAX_BYTES,
    usedBytes: bigUsedBytes,
    totalBytes: BIG_TOTAL_BYTES
  });
});


// Shared lookup for the info/download routes
function bigEntryFor(req, res) {
  const entry = bigStore.get(req.params.code);
  if (!entry) {
    res.status(404).json({ error: 'Invalid or expired code.' });
    return null;
  }
  if (entry.expiresAt < Date.now()) {
    bigDelete(req.params.code);
    res.status(404).json({ error: 'Code has expired.' });
    return null;
  }
  if (!fs.existsSync(entry.filePath)) {
    bigDelete(req.params.code);
    res.status(404).json({ error: 'File no longer available.' });
    return null;
  }
  return entry;
}

// GET /api/big/info/:code — file metadata for the code
app.get('/api/big/info/:code', (req, res) => {
  const entry = bigEntryFor(req, res);
  if (!entry) return;
  res.json({
    name: entry.originalName,
    size: entry.size,
    mimetype: entry.mimetype,
    expiresAt: entry.expiresAt
  });
});

// GET /api/big/download/:code — res.download() supports HTTP Range requests, so
// a multi-GB transfer can be paused/resumed instead of restarting from zero.
app.get('/api/big/download/:code', (req, res) => {
  const entry = bigEntryFor(req, res);
  if (!entry) return;
  res.download(entry.filePath, entry.originalName, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: 'Download failed.' });
    }
  });
});

const server = app.listen(PORT, () => {
  console.log(`ClipDrop running at http://localhost:${PORT}`);
  console.log(`  small files: 50 MB, 4-digit codes (unchanged)`);
  console.log(`  large files: ${bigLimitLabel(BIG_MAX_GB)} per file, 6-digit codes (${bigLimitLabel(BIG_TOTAL_GB)} storage cap)`);
});

// Node's default 5-minute requestTimeout would abort multi-GB uploads mid-way.
// ClipDrop's 50 MB uploads never came near it, so they are unaffected.
server.requestTimeout = 0;
