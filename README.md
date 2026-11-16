# ClipDrop — File Clipboard with OTP

A minimal, self-hosted web app to upload files and retrieve them with a 4-digit OTP code.

## Features
- Upload any file (up to 50 MB)
- Get a unique 4-digit OTP code instantly
- Anyone with the code can download the file
- Files auto-expire and delete after **24 hours**
- Upload progress bar
- Drag & drop support
- Mobile-friendly

## Setup

### Requirements
- [Node.js](https://nodejs.org/) v16 or higher

### Install & Run

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start
```

Then open **http://localhost:3000** in your browser.

### Custom Port
```bash
PORT=8080 npm start
```

## Large file transfer (same Wi-Fi)

A second, **separate** transfer mode for big files (movies, VM images, backups). It is fully
independent of the 50 MB OTP flow: its own routes (`/api/big/*`), its own folder
(`uploads/big/`), its own in-memory store and its own **6-digit** codes. Nothing above changes
when you use it.

| | ClipDrop (unchanged) | Large file |
|---|---|---|
| Max size | 50 MB | **20 GB** per file (`BIG_MAX_GB`) |
| Code | 4-digit | 6-digit |
| Storage | `uploads/` | `uploads/big/` |
| Download | plain stream | `res.download()` — HTTP Range, so it can be paused/resumed |

### How to use it on the same Wi-Fi
1. On the **sending** laptop run `npm start`.
2. Find its LAN address: `ipconfig` → **IPv4 Address** (e.g. `192.168.1.42`).
3. On the **receiving** laptop open `http://192.168.1.42:3000` — no software to install,
   a browser is enough.
4. Sender: **Large file** tab → drop the file → **Generate code** → read out the 6-digit code.
5. Receiver: **Large file** tab → type the code → **Find file** → **Download**.

If Windows Firewall blocks the connection from the other laptop, allow Node.js on
**Private** networks (or `netsh advfirewall firewall add rule name="ClipDrop" dir=in action=allow protocol=TCP localport=3000`).

### Limits and tuning
```bash
BIG_MAX_GB=20 npm start     # per-file cap        (default 20 GB)
BIG_TOTAL_GB=60 npm start   # folder cap          (default 60 GB)
```
- Files are deleted automatically after **24 hours** (same retention as ClipDrop); orphaned
  files in `uploads/big/` are swept on the same schedule.
- Large downloads support HTTP Range, so an interrupted transfer can be resumed by the browser.
- Transfers are plain HTTP on your own network — no cloud upload, no size metering, speed is
  whatever your Wi-Fi gives you.
- Very large single uploads (10 GB+) depend on the browser being able to hold an open request
  that long; a wired connection or 5 GHz Wi-Fi is much faster than 2.4 GHz.



### Option A — Railway (easiest, free tier)
1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. It auto-detects Node.js and runs `npm start`
4. Railway gives you a public URL instantly

### Option B — Render (free tier)
1. Push to GitHub
2. Go to [render.com](https://render.com) → New Web Service
3. Connect your repo, set Start Command to `npm start`
4. Deploy — you get a public URL

### Option C — VPS / your own server
```bash
npm install -g pm2
pm2 start server.js --name clipdrop
pm2 save
```
Use nginx as a reverse proxy pointing to port 3000.

## File Structure
```
clipboardapp/
├── server.js        # Express backend
├── package.json
├── public/
│   └── index.html   # Frontend (served statically)
└── uploads/         # Temp file storage (auto-created)
```

## Notes
- Files are stored on disk in `/uploads/` and deleted after 24 hours
- OTPs are stored in memory — restarting the server clears them
- For production persistence, consider adding a database (SQLite, Postgres)
