# FaceSense — Phase 4: Production-Ready AI Wellness Monitor

> Real-time stress · fatigue · emotion detection  
> Browser notifications · Analytics dashboard · Full deployment pipeline

---

## What's New in Phase 4

| Feature | Details |
|---|---|
| 🔔 Browser Notifications | Permission requested on first visit. Fires on sustained high stress (10s+) or low blink rate. |
| 📊 Analytics Dashboard | `/dashboard` with 4 live recharts + summary stat cards |
| 📈 Stress over time | Line chart — avg + peak stress (5-min buckets) |
| 👁 Blink rate trend | Line chart — blink rate over time |
| 😊 Emotion distribution | Bar chart with % breakdown |
| 🚨 Alert history | Stored in MongoDB, displayed in dashboard |
| 🌐 Service Worker | Registered at `/sw.js` for future push support |
| 🚀 Deploy configs | `vercel.json` + `render.yaml` included |

All Phase 1–3 features are preserved and unchanged.

---

## Project Structure

```
facesense-phase4/
├── app/
│   ├── layout.tsx              ← Phase 4: SW registration, updated metadata
│   ├── page.tsx                ← Main camera page (Phase 1–4 combined)
│   ├── dashboard/
│   │   └── page.tsx            ← NEW: Analytics dashboard (recharts)
│   └── globals.css
├── public/
│   ├── sw.js                   ← NEW: Service worker
│   └── models/                 ← face-api.js models (unchanged)
├── server/
│   ├── index.js                ← Phase 4: registers analytics + alert routes
│   ├── config/db.js
│   ├── models/
│   │   ├── Session.js          ← unchanged
│   │   ├── Baseline.js         ← unchanged
│   │   ├── UserModel.js        ← unchanged
│   │   └── Alert.js            ← NEW: alert history schema
│   └── routes/
│       ├── sessionRoutes.js    ← unchanged
│       ├── baselineRoutes.js   ← unchanged
│       ├── userModelRoutes.js  ← unchanged
│       ├── analyticsRoutes.js  ← NEW: stress/blink/emotion/summary
│       └── alertRoutes.js      ← NEW: POST + GET /api/alerts
├── vercel.json                 ← NEW
├── render.yaml                 ← NEW
├── package.json                ← recharts added
├── .env.local.example
└── server/.env.example
```

---

## Quick Start (Local)

### 1. Frontend

```bash
# From project root
npm install          # installs recharts + all deps
cp .env.local.example .env.local
# Edit .env.local → NEXT_PUBLIC_BACKEND_URL=http://localhost:5000
npm run dev
```

### 2. Backend

```bash
cd server
npm install
cp .env.example .env
# Edit .env → paste your MONGO_URI from MongoDB Atlas
node index.js
```

### 3. Open

- **Camera:** http://localhost:3000
- **Dashboard:** http://localhost:3000/dashboard

---

## Phase 4 API Endpoints

### Analytics

| Method | Path | Description |
|---|---|---|
| GET | `/api/analytics/summary` | Header card stats |
| GET | `/api/analytics/stress` | Stress over time (bucketed) |
| GET | `/api/analytics/blink` | Blink rate over time (bucketed) |
| GET | `/api/analytics/emotion` | Emotion frequency distribution |

All accept query params: `userId` (required), `from` (ISO), `to` (ISO)

### Alerts

| Method | Path | Description |
|---|---|---|
| POST | `/api/alerts` | Store alert event |
| GET | `/api/alerts` | Retrieve alert history |

Body for POST: `{ userId, sessionId, type, stressScore, blinkRate }`

---

## Notification Behaviour

| Trigger | Condition | Message |
|---|---|---|
| High Stress | Stress > threshold for 10s continuously | "⚠ High Stress Detected. Take a short break." |
| Low Blink | Blink rate < threshold after 30s warmup | "👁 Low Blink Rate Detected. Look away and blink." |

- Permission prompt appears on first camera session start
- Each alert type fires once per event (deduplication with `alertBlinkRef`)
- Alerts persist to MongoDB via `POST /api/alerts` automatically

---

## Deployment (All Free)

### Frontend → Vercel

```bash
npm i -g vercel
vercel
# Set: NEXT_PUBLIC_BACKEND_URL=https://your-backend.onrender.com
```

Or: push to GitHub → import at vercel.com → set env var → deploy.

### Backend → Render

1. Push to GitHub
2. New Web Service at render.com
3. Root dir: `server` · Build: `npm install` · Start: `node index.js`
4. Set env vars: `MONGO_URI`, `PORT=5000`, `FRONTEND_URL=https://your-app.vercel.app`, `NODE_ENV=production`

### Database → MongoDB Atlas

1. Create free M0 cluster at cloud.mongodb.com
2. Database Access → add user with password
3. Network Access → Allow `0.0.0.0/0`
4. Connect → Drivers → copy URI → paste as `MONGO_URI`

Collections auto-created: `sessions`, `baselines`, `usermodels`, `alerts`

---

## End-to-End Testing Checklist

### Phase 1–3 regression (must still pass)

```
□ Camera opens, face detected, landmarks drawn
□ Emotion, stress score, blink count update in real-time
□ Calibration bar runs for 30s then disappears
□ KNN training buttons work (Train Relaxed / Train Stressed)
□ Session data saved to MongoDB (check Atlas → sessions collection)
□ GET /api/session?userId=<id> returns documents
□ GET /api/baseline/:userId returns calibration data
□ GET /api/usermodel/:userId returns KNN samples
```

### Phase 4 new features

```
□ Notification permission prompt appears on first visit
□ "🔔 notifications on" label shows after granting permission
□ Stress alert → browser notification fires after 10s of high stress
□ Blink alert → browser notification fires after 45s of low blink rate
□ Alert saved to MongoDB (GET /api/alerts?userId=<id>)
□ Dashboard loads at /dashboard
□ All 4 charts render with data (after running camera session)
□ Date range selector filters data correctly
□ Alert history panel shows alert events
□ Refresh button works
□ "← Camera" link navigates back
□ Service worker active in DevTools → Application → Service Workers
```

### API smoke tests

```bash
# Replace <id> with your userId from localStorage (browser console: localStorage.facesense_userId)

curl "http://localhost:5000/health"
# → {"status":"ok","version":"4.0",...}

curl "http://localhost:5000/api/analytics/summary?userId=<id>"
# → {"avgStress":0.4,"maxStress":0.8,...}

curl "http://localhost:5000/api/analytics/stress?userId=<id>"
# → {"data":[{"timestamp":"...","avgStress":0.4,...}]}

curl "http://localhost:5000/api/analytics/emotion?userId=<id>"
# → {"data":[{"emotion":"neutral","count":120,"pct":57.7}]}

curl "http://localhost:5000/api/alerts?userId=<id>"
# → {"count":2,"data":[{"type":"stress",...}]}
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Dashboard shows "No User Data Found" | Run a camera session on main page first |
| Charts empty | Try "All time" date range. Check backend is running. |
| Notifications don't appear | Browser Settings → Notifications → allow for localhost |
| `recharts` not found | Run `npm install` in project root |
| CORS error from backend | Set `FRONTEND_URL` env var to your Vercel URL |
| MongoDB timeout | Check MONGO_URI + Network Access allows 0.0.0.0/0 |
| Render backend slow first load | Free tier cold starts take ~30s after 15min idle |

---

## Free Tier Summary

| Service | Limit | Usage |
|---|---|---|
| Vercel | 100GB/mo bandwidth | ✅ well within |
| Render | 750 hrs/mo | ✅ fits 1 instance |
| MongoDB Atlas M0 | 512MB storage | ✅ ~500K documents |
| Notification API | Unlimited | ✅ browser-native |

---

*FaceSense Phase 4 · Next.js · face-api.js · Express · MongoDB · recharts*
