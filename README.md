# 🧠 FaceSense — Phase 1: Real-time Face Detection

A fully **client-side**, browser-based face detection system built with Next.js, React, Tailwind CSS, and face-api.js.

**No backend. No paid APIs. No data leaves your device.**

---

## ✨ What It Does

| Feature | Details |
|---|---|
| 📷 Webcam access | `navigator.mediaDevices.getUserMedia` |
| 🔍 Face detection | SSD MobileNet v1 via face-api.js |
| 🗺 Facial landmarks | 68-point overlay (jaw, eyes, brows, nose, mouth) |
| 📦 Model loading | Served locally from `/public/models/` |
| ⚡ Rendering | `requestAnimationFrame` loop — ~20–30 fps |
| 🛡 Privacy | Zero data sent anywhere — runs 100% in your browser |

---

## 🚀 Quick Start

### 1. Clone or unzip the project

```bash
cd facesense-phase1
```

### 2. Install dependencies

```bash
npm install
```

### 3. Download model weights *(one-time setup)*

```bash
node scripts/download-models.js
```

This downloads ~6 MB of model files from GitHub into `public/models/`.

### 4. Start the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## 📁 Project Structure

```
facesense-phase1/
├── app/
│   ├── page.tsx          ← Main face detection UI + logic
│   ├── layout.tsx        ← HTML shell + metadata
│   └── globals.css       ← Base styles + Tailwind
│
├── public/
│   └── models/           ← face-api.js weight files (downloaded separately)
│       ├── .gitkeep
│       ├── ssd_mobilenetv1_model-weights_manifest.json
│       ├── ssd_mobilenetv1_model-shard1
│       ├── face_landmark_68_model-weights_manifest.json
│       └── face_landmark_68_model-shard1
│
├── scripts/
│   └── download-models.js  ← One-time model weight downloader
│
├── next.config.ts          ← Webpack fs-fallback for face-api.js
├── tailwind.config.ts      ← Tailwind config
├── tsconfig.json           ← TypeScript config
└── package.json
```

---

## 🧩 Architecture

```
Browser
  │
  ├── MediaDevices API ──► <video> element (mirrored)
  │                              │
  │                              ▼
  ├── face-api.js ──► detectAllFaces().withFaceLandmarks()
  │       │
  │       ├── SSD MobileNet v1   (face bounding boxes)
  │       └── FaceLandmark68Net  (68 facial keypoints)
  │
  └── Canvas 2D API ──► draws boxes + landmarks each frame
```

---

## 🎨 UI Features

- **Dark terminal aesthetic** — `#0a0a0f` background, neon cyan accents
- **Live HUD** — face count + FPS counter overlaid on feed
- **LIVE badge** — red pulsing indicator when camera is active  
- **Status states** — Camera Off / Loading Models / Requesting Camera / Detecting / No Face / Error
- **Color-coded landmarks**:
  - 🩵 Cyan — jaw line, nose bridge
  - 💜 Purple — eyes
  - 💗 Pink — eyebrows, mouth

---

## 🧠 Models Used

| Model | Purpose | Size |
|---|---|---|
| `ssd_mobilenetv1` | Detects face bounding boxes | ~5.4 MB |
| `faceLandmark68Net` | Predicts 68 facial landmarks | ~350 KB |

Both are open-source and hosted on the [official face-api.js GitHub](https://github.com/justadudewhohacks/face-api.js).

---

## 🌐 Deploy to Vercel (Free)

```bash
# 1. Push to GitHub
git init
git add .
git commit -m "FaceSense Phase 1"
git remote add origin https://github.com/YOUR_USERNAME/facesense-phase1.git
git push -u origin main

# 2. Import at https://vercel.com/new
# 3. Click Deploy — no configuration needed
```

> ⚠️ **Important**: Run `node scripts/download-models.js` **before** pushing, so `public/models/` is committed and included in the Vercel build.

---

## 🛠 Troubleshooting

### ❌ "Model load failed"

```
Model load failed: Failed to fetch
```

**Cause**: Model files missing from `public/models/`.

**Fix**:
```bash
node scripts/download-models.js
```

---

### ❌ Camera permission denied

**Cause**: Browser blocked camera access.

**Fix**:
1. Click the camera icon in your browser's address bar
2. Select "Allow" for camera
3. Refresh the page and try again

On macOS: System Settings → Privacy & Security → Camera → enable for your browser.

---

### ❌ No face detected / orange status

**Cause**: Face not clearly visible or confidence < 50%.

**Fix**:
- Ensure good lighting (face the light source, don't backlight yourself)
- Move closer to camera
- Avoid covering your face

---

### ❌ Low FPS / choppy detection

**Cause**: Older CPU or heavy browser load.

**Fix**:
- Close other browser tabs
- Detection runs on CPU — no GPU required but benefits from a fast CPU
- Typical performance: ~20–30 fps on modern hardware

---

### ❌ TypeScript errors on `faceapi.Point`

**Cause**: face-api.js typings version mismatch.

**Fix**:
```bash
npm install face-api.js@latest
```

---

## 🔮 Phase 2 (Coming Next)

Phase 2 will add:
- 😊 Emotion detection (happy, sad, angry, surprised, neutral, fearful, disgusted)
- 📊 Confidence scores per emotion
- Real-time emotion history graph

---

## 📄 License

MIT — free for personal and commercial use.

Built with:
- [Next.js](https://nextjs.org) — React framework
- [face-api.js](https://github.com/justadudewhohacks/face-api.js) — Face detection in the browser
- [Tailwind CSS](https://tailwindcss.com) — Utility-first CSS
- [Vercel](https://vercel.com) — Free hosting
