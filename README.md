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

## Deploying to the Web

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
