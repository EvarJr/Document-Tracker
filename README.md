# Document Scanner — MVP

A document scanning system: upload a blank template, mark input fields once,
then scan filled copies of that document to auto-extract the field values
into a formatted Excel file.

This is the **MVP / proof-of-concept stage**. Current scope: a working
frontend + backend connection, deployed live, for free, with no cold-start
issues on the backend. OCR, template editing, Google Drive storage, and
Excel export get layered on top in following steps.

## Stack

- **Frontend:** React + Vite, deployed to GitHub Pages (free, static)
- **Backend:** FastAPI (Python), deployed to Render free tier
- **Keep-alive:** GitHub Actions cron job pings the backend every 10 minutes
  so it never spins down from Render's 15-minute inactivity timeout

## Project structure

```
document-scanner/
├── frontend/              React + Vite app
│   └── src/
│       ├── App.jsx        Main shell, backend status check
│       └── config.js      Backend API URL (edit this after deploying backend)
├── backend/                FastAPI app
│   ├── main.py             App entrypoint, /health endpoint
│   ├── requirements.txt
│   └── render.yaml         Render deployment blueprint
└── .github/workflows/
    ├── keep-alive.yml       Pings backend every 10 min (edit URL before use)
    └── deploy-frontend.yml  Auto-deploys frontend to GitHub Pages on push
```

## Setup — do this in order

### 1. Push this repo to GitHub
```
git init
git add .
git commit -m "Initial scaffold"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/document-scanner.git
git push -u origin main
```

### 2. Deploy the backend to Render
1. Go to [render.com](https://render.com), sign up free (no card required)
2. New → Web Service → connect this GitHub repo
3. Set **Root Directory** to `backend`
4. Render should auto-detect `render.yaml` — confirm build/start commands match
5. Deploy. Once live, copy your backend URL (e.g. `https://document-scanner-api.onrender.com`)

### 3. Wire the frontend to the backend
- Edit `frontend/src/config.js` → set `API_BASE_URL` to your real Render URL

### 4. Enable GitHub Pages
1. In your GitHub repo: Settings → Pages → Source: "GitHub Actions"
2. Push to `main` — the `deploy-frontend.yml` workflow builds and deploys automatically
3. Confirm `frontend/vite.config.js` → `base` matches your repo name exactly

### 5. Turn on the keep-alive ping
- Edit `.github/workflows/keep-alive.yml` → replace `YOUR-APP-NAME` with your real Render subdomain
- It runs automatically every 10 minutes once pushed to `main`
- Test it manually anytime: repo → Actions tab → "Keep Render Alive" → Run workflow

## Verifying it all works
Visit your GitHub Pages URL. The page should show:
- Frontend: running
- Backend: connected

If backend shows "unreachable," wait ~30–50 seconds (cold start on first-ever request) and refresh.

## Roadmap (not yet built)
- [ ] Template upload + OpenCV.js perspective correction
- [ ] Field-box editor (canvas-based, draw/label/save fields as JSON)
- [ ] Google Sign-In (OAuth 2.0) + Drive API for template/output storage
- [ ] Scan flow: align photo to template → crop fields → OCR each field
- [ ] Editable review screen before saving
- [ ] Excel export (openpyxl)
- [ ] WordPress marketing site + embed plugin (post-MVP)
