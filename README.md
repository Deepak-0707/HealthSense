# FaceSense — Phase 2

Real-time face analytics: **emotion detection**, **stress estimation**, **blink rate tracking**, and a persistent backend.

---

## What's New in Phase 2

| Feature | Details |
|---|---|
| Emotion detection | 7 classes via `faceExpressionNet` (happy, sad, angry, fearful, disgusted, surprised, neutral) |
| Stress score | Weighted emotion → 0–100% bar, colour-coded green/orange/red |
| Blink detection | Eye Aspect Ratio (EAR) on landmarks 36–47 |
| Blink rate alert | Warning if < 8 blinks/min after first 30 s |
| Stress alert | Red UI flash + audio beep if stress > 70% for 10+ seconds |
| Analytics panel | Live sidebar: emotion emoji, stress bar, blink stats, backend status |
| Express backend | Node.js + Express on port 5000 |
| MongoDB Atlas | Session snapshots saved every 3 s |
| REST API | `POST /api/session`, `GET /api/session`, `GET /api/session/stats` |

All Phase 1 features (face detection, landmarks, canvas, FPS HUD, mirrored label fix) are **unchanged**.

---

## Folder Structure

```
facesense-phase2/
├── app/
│   ├── page.tsx              ← Phase 2 frontend (extended)
│   ├── layout.tsx
│   └── globals.css
├── public/
│   └── models/               ← model weights (downloaded by script)
├── scripts/
│   └── download-models.js    ← updated: now downloads expression model too
├── server/                   ← NEW — Express backend
│   ├── config/
│   │   └── db.js
│   ├── models/
│   │   └── Session.js
│   ├── routes/
│   │   └── sessionRoutes.js
│   ├── index.js
│   ├── package.json
│   └── .env.example
├── .env.local.example
├── package.json
└── README.md
```

---

## Quick Start

### 1. Install frontend dependencies

```bash
npm install
```

### 2. Download all model weights (Phase 1 + Phase 2)

```bash
node scripts/download-models.js
```

Downloads ~12 MB into `public/models/`. Run only once; skips existing files.

### 3. Set up the backend

```bash
cd server
npm install
cp .env.example .env
# Edit .env — paste your MongoDB Atlas connection string
```

### 4. Set frontend env (optional — defaults to localhost:5000)

```bash
# project root
cp .env.local.example .env.local
```

### 5. Run both servers (two terminals)

**Terminal 1 — Backend:**
```bash
cd server
npm start        # or: npm run dev  (nodemon)
```

**Terminal 2 — Frontend:**
```bash
# project root
npm run dev
```

Open **http://localhost:3000**

---

## MongoDB Atlas Setup

1. Sign in at [https://cloud.mongodb.com](https://cloud.mongodb.com) (free account)
2. Create a **free M0 cluster**
3. **Security → Database Access** → add a user with Read/Write permissions
4. **Security → Network Access** → add `0.0.0.0/0` for local dev
5. **Connect → Drivers → Node.js** → copy the connection string
6. Paste into `server/.env`:

```env
MONGO_URI=mongodb+srv://myuser:mypassword@cluster0.abcde.mongodb.net/facesense?retryWrites=true&w=majority
PORT=5000
```

---

## API Reference

Base URL: `http://localhost:5000`

### `GET /health`
```json
{ "status": "ok", "timestamp": "2024-01-01T00:00:00.000Z" }
```

### `POST /api/session`
Save one analytics snapshot.

**Body:**
```json
{
  "emotion": "neutral",
  "stressScore": 0.12,
  "blinkRate": 14,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```
**Response 201:**
```json
{ "success": true, "id": "66a1b2c3..." }
```

### `GET /api/session`

| Query | Default | Description |
|---|---|---|
| `limit` | 100 | Max records (cap 500) |
| `since` | — | ISO datetime filter |

```bash
curl "http://localhost:5000/api/session?limit=20"
```

### `GET /api/session/stats`

```bash
curl "http://localhost:5000/api/session/stats"
```
```json
{
  "summary": { "avgStress": 0.18, "maxStress": 0.71, "avgBlinkRate": 13, "count": 48 },
  "emotionBreakdown": [
    { "_id": "neutral", "count": 30 },
    { "_id": "happy",   "count": 12 }
  ]
}
```

---

## Manual API Test

```bash
# Health
curl http://localhost:5000/health

# Post a test record
curl -X POST http://localhost:5000/api/session \
  -H "Content-Type: application/json" \
  -d '{"emotion":"happy","stressScore":0.08,"blinkRate":15}'

# Fetch records
curl "http://localhost:5000/api/session?limit=5"

# Aggregated stats
curl "http://localhost:5000/api/session/stats"
```

---

## Alert Thresholds

| Alert | Condition | UI |
|---|---|---|
| High Stress | > 70% for 10+ seconds | Red border + banner + 880 Hz beep |
| Low Blink Rate | < 8/min after 30 s | Amber banner |

---

## Offline Behaviour

The frontend works without the backend. If the server is unreachable the Backend indicator turns red and sessions are simply not saved — detection continues normally.

---

## Performance

- Inference: **150 ms** interval (~6–7 fps) — smooth, CPU-friendly
- Canvas draw: **60 fps** via requestAnimationFrame — decoupled from inference
- API posts: **every 3 s** — not every frame
