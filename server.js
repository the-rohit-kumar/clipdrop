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

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok', files: otpStore.size }));

app.listen(PORT, () => {
  console.log(`ClipDrop running at http://localhost:${PORT}`);
});
