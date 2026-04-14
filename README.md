# FaceSense Phase 3

Personalized emotion, stress, and blink detection with adaptive AI.

## What's new in Phase 3

| Feature | Detail |
|---|---|
| User identity | UUID stored in localStorage, sent with every API call |
| Session management | Per-camera-run sessionId |
| Baseline calibration | 30s window on session start → adaptive thresholds |
| Adaptive thresholds | stressThreshold = avgStress+0.2, blinkThreshold = avgBlinkRate×0.7 |
| KNN training mode | Capture relaxed/stressed samples, stored in MongoDB |
| KNN classifier | Euclidean distance, k=3, pure JS (no extra libs) |
| Alert cooldown | 30s minimum between alerts |
| API batching | Buffer every 5s, send array payload |
| Input validation | Backend rejects invalid userId, stressScore, blinkRate, emotion |
| Error handling | Falls back to Phase 2 thresholds if no baseline |

## Setup

### Frontend
```bash
npm install
cp .env.local.example .env.local   # set NEXT_PUBLIC_BACKEND_URL
node scripts/download-models.js    # also add faceRecognitionNet
npm run dev
```

### Backend
```bash
cd server
npm install
cp .env.example .env               # set MONGO_URI
npm run dev
```

## Model download note

Phase 3 also requires `face_recognition_net` for face descriptors used by KNN.
Add to `scripts/download-models.js` or download manually from:
https://github.com/vladmandic/face-api/tree/master/model

Files needed (in addition to Phase 2):
- `face_recognition_model-weights_manifest.json`
- `face_recognition_model-shard1`

## API endpoints

| Method | Path | Description |
|---|---|---|
| POST | /api/session | Save snapshot(s) — accepts array |
| GET | /api/session | Get history (?userId=…&limit=50) |
| GET | /api/session/stats | Aggregated stats (?userId=…) |
| POST | /api/baseline | Save calibration baseline |
| GET | /api/baseline/:userId | Get baseline + adaptive thresholds |
| POST | /api/usermodel | Save KNN training samples |
| GET | /api/usermodel/:userId | Get user model |
| DELETE | /api/usermodel/:userId | Delete user model |
| GET | /health | Health check |
