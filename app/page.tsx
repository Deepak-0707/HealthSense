"use client";

/**
 * FaceSense Phase 2 — Emotion · Stress · Blink Detection
 *
 * Phase 1 features preserved:
 *   ✓ Webcam streaming
 *   ✓ Face detection (SSD MobileNet v1)
 *   ✓ 68-point landmark detection
 *   ✓ Canvas rendering with mirrored-label fix
 *   ✓ willReadFrequently optimisation
 *   ✓ Decoupled inference / draw loops
 *
 * Phase 2 additions:
 *   + Emotion detection via faceExpressionNet
 *   + Stress score derived from emotion weights
 *   + Blink detection via Eye Aspect Ratio (EAR)
 *   + Alert system (stress > 0.7 for 10 s, blink rate < 8 /min)
 *   + Analytics panel (emotion, stress bar, blink rate)
 *   + Backend POST every 3 s (non-blocking, gracefully offline)
 */

import { useEffect, useRef, useCallback, useState } from "react";
import * as faceapi from "face-api.js";

// ─── Types ─────────────────────────────────────────────────────────────────────
type Status =
  | "idle"
  | "loading-models"
  | "models-ready"
  | "requesting-camera"
  | "detecting"
  | "no-face"
  | "error";

const STATUS_LABELS: Record<Status, string> = {
  idle: "Camera Off",
  "loading-models": "Loading Models…",
  "models-ready": "Models Ready",
  "requesting-camera": "Requesting Camera…",
  detecting: "Detecting Face…",
  "no-face": "No Face Detected",
  error: "Error — See Below",
};

const STATUS_COLORS: Record<Status, string> = {
  idle: "text-zinc-500",
  "loading-models": "text-amber-400",
  "models-ready": "text-sky-400",
  "requesting-camera": "text-amber-400",
  detecting: "text-emerald-400",
  "no-face": "text-orange-400",
  error: "text-red-400",
};

type FaceResult = {
  detection: faceapi.FaceDetection;
  landmarks: faceapi.FaceLandmarks68;
  expressions: faceapi.FaceExpressions;
};

// Stress weights per emotion (0 = calm, 1 = max stress)
const STRESS_WEIGHTS: Record<string, number> = {
  angry: 0.95,
  disgusted: 0.75,
  fearful: 0.90,
  sad: 0.65,
  surprised: 0.45,
  neutral: 0.10,
  happy: 0.05,
};

const EMOTION_EMOJI: Record<string, string> = {
  angry: "😠",
  disgusted: "🤢",
  fearful: "😨",
  sad: "😢",
  surprised: "😲",
  neutral: "😐",
  happy: "😊",
};

const EMOTION_COLORS: Record<string, string> = {
  angry: "#ef4444",
  disgusted: "#a855f7",
  fearful: "#f97316",
  sad: "#3b82f6",
  surprised: "#eab308",
  neutral: "#6b7280",
  happy: "#22c55e",
};

// EAR threshold — eyes considered closed below this.
// face-api.js landmarks at typical webcam resolution yield EAR ~0.25–0.35 open,
// ~0.10–0.18 fully closed. 0.21 is too tight and misses real blinks. 0.25 is reliable.
const EAR_THRESHOLD = 0.25;
// At 150 ms inference a real blink (100–400 ms) spans only 1–2 frames.
// Requiring 2 consecutive frames causes short blinks to be missed entirely.
const BLINK_CONSEC_FRAMES = 1;
// Minimum elapsed seconds before reporting a rate (avoids "60/min" after 1 blink in 1 s)
const BLINK_RATE_MIN_ELAPSED_S = 10;

// ─── EAR Calculation ───────────────────────────────────────────────────────────
function euclidean(a: faceapi.Point, b: faceapi.Point) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function eyeAspectRatio(pts: faceapi.Point[]): number {
  // Soukupova & Cech 2016 formula
  const A = euclidean(pts[1], pts[5]);
  const B = euclidean(pts[2], pts[4]);
  const C = euclidean(pts[0], pts[3]);
  return (A + B) / (2.0 * C);
}

// ─── Stress calculation ────────────────────────────────────────────────────────
function mapEmotionToStress(expressions: faceapi.FaceExpressions): number {
  let score = 0;
  const exprObj = expressions as unknown as Record<string, number>;
  for (const [emotion, weight] of Object.entries(STRESS_WEIGHTS)) {
    score += (exprObj[emotion] ?? 0) * weight;
  }
  return Math.min(1, score);
}

function dominantEmotion(expressions: faceapi.FaceExpressions): string {
  const exprObj = expressions as unknown as Record<string, number>;
  return Object.entries(exprObj).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

// ─── Backend helpers ───────────────────────────────────────────────────────────
const BACKEND_URL =
  typeof process !== "undefined" && process.env.NEXT_PUBLIC_BACKEND_URL
    ? process.env.NEXT_PUBLIC_BACKEND_URL
    : "http://localhost:5000";

// ─── Component ─────────────────────────────────────────────────────────────────
export default function FaceSensePage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const rafRef = useRef<number | null>(null);
  const inferIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const apiIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const latestResultsRef = useRef<FaceResult[]>([]);

  const modelsLoadedRef = useRef(false);
  const isRunningRef = useRef(false);

  // Blink tracking
  const blinkCountRef = useRef(0);
  const blinkConsecRef = useRef(0);
  const blinkStartTimeRef = useRef<number>(Date.now());
  const eyeClosedRef = useRef(false);

  // Stress alert tracking
  const stressHighSinceRef = useRef<number | null>(null);
  const alertFiredRef = useRef(false);

  // Latest analytics refs (for draw loop and API loop — no stale closures)
  const latestEmotionRef = useRef("neutral");
  const latestStressRef = useRef(0);
  const latestBlinkRateRef = useRef(0);

  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [faceCount, setFaceCount] = useState(0);
  const [fps, setFps] = useState(0);

  // Phase 2 UI state
  const [emotion, setEmotion] = useState("neutral");
  const [stressScore, setStressScore] = useState(0);
  const [blinkRate, setBlinkRate] = useState(0);
  const [blinkCount, setBlinkCount] = useState(0);
  const [alertStress, setAlertStress] = useState(false);
  const [alertBlink, setAlertBlink] = useState(false);
  const [backendOk, setBackendOk] = useState<boolean | null>(null);

  const fpsRef = useRef({ frames: 0, last: performance.now() });

  // ── Load models (Phase 2 adds faceExpressionNet) ─────────────────────────────
  const loadModels = useCallback(async () => {
    if (modelsLoadedRef.current) return;
    setStatus("loading-models");
    setErrorMsg("");
    try {
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri("/models"),
        faceapi.nets.faceLandmark68Net.loadFromUri("/models"),
        faceapi.nets.faceExpressionNet.loadFromUri("/models"),
      ]);
      modelsLoadedRef.current = true;
      setStatus("models-ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setErrorMsg(
        `Model load failed: ${msg}. Run: node scripts/download-models.js`
      );
      setStatus("error");
    }
  }, []);

  // ── Start camera ─────────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    if (!modelsLoadedRef.current) {
      await loadModels();
      if (!modelsLoadedRef.current) return;
    }
    setStatus("requesting-camera");
    setErrorMsg("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;

      const video = videoRef.current!;
      video.srcObject = stream;
      await new Promise<void>((resolve) => {
        video.onloadedmetadata = () => { video.play().then(resolve); };
      });

      const canvas = canvasRef.current!;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      // Reset Phase 2 state
      blinkCountRef.current = 0;
      blinkConsecRef.current = 0;
      blinkStartTimeRef.current = Date.now();
      eyeClosedRef.current = false;
      stressHighSinceRef.current = null;
      alertFiredRef.current = false;

      isRunningRef.current = true;
      setStatus("detecting");
      startInferenceLoop();
      startDrawLoop();
      startApiLoop();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (/permission|denied/i.test(msg)) {
        setErrorMsg("Camera access denied. Allow camera in browser settings.");
      } else if (/notfound|devices/i.test(msg)) {
        setErrorMsg("No camera found on this device.");
      } else {
        setErrorMsg(`Camera error: ${msg}`);
      }
      setStatus("error");
    }
  }, [loadModels]);

  // ── Stop camera ──────────────────────────────────────────────────────────────
  const stopCamera = useCallback(() => {
    isRunningRef.current = false;

    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (inferIntervalRef.current !== null) { clearInterval(inferIntervalRef.current); inferIntervalRef.current = null; }
    if (apiIntervalRef.current !== null) { clearInterval(apiIntervalRef.current); apiIntervalRef.current = null; }
    latestResultsRef.current = [];

    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;

    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }

    setFaceCount(0); setFps(0);
    setEmotion("neutral"); setStressScore(0); setBlinkRate(0); setBlinkCount(0);
    setAlertStress(false); setAlertBlink(false);
    setStatus("idle"); setErrorMsg("");
  }, []);

  // ── Inference loop — 150 ms, Phase 2: withFaceExpressions ───────────────────
  const startInferenceLoop = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    inferIntervalRef.current = setInterval(async () => {
      if (!isRunningRef.current || !video || video.paused || video.ended) return;

      try {
        const detections = await faceapi
          .detectAllFaces(video, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
          .withFaceLandmarks()
          .withFaceExpressions();

        const displaySize = { width: video.videoWidth, height: video.videoHeight };
        const resized = faceapi.resizeResults(detections, displaySize) as FaceResult[];
        latestResultsRef.current = resized;

        setFaceCount(resized.length);
        setStatus(resized.length === 0 ? "no-face" : "detecting");

        if (resized.length > 0) {
          const first = resized[0];

          // ── Emotion & Stress ─────────────────────────────────────────────
          const dom = dominantEmotion(first.expressions);
          const stress = mapEmotionToStress(first.expressions);
          latestEmotionRef.current = dom;
          latestStressRef.current = stress;
          setEmotion(dom);
          setStressScore(Math.round(stress * 100) / 100);

          // ── Blink (EAR) ──────────────────────────────────────────────────
          const pts = first.landmarks.positions;
          const leftEye = pts.slice(36, 42);
          const rightEye = pts.slice(42, 48);
          const ear = (eyeAspectRatio(leftEye) + eyeAspectRatio(rightEye)) / 2;

          if (ear < EAR_THRESHOLD) {
            blinkConsecRef.current++;
          } else {
            if (blinkConsecRef.current >= BLINK_CONSEC_FRAMES) {
              blinkCountRef.current++;
              setBlinkCount(blinkCountRef.current);
            }
            blinkConsecRef.current = 0;
          }
          eyeClosedRef.current = ear < EAR_THRESHOLD;

          // Rate: use elapsed time but clamp to a rolling 60-s window to avoid
          // wild numbers at session start, and require at least 10 s of data.
          const elapsedSec = (Date.now() - blinkStartTimeRef.current) / 1000;
          const windowSec = Math.min(elapsedSec, 60); // cap at 60 s window
          const rate = elapsedSec >= BLINK_RATE_MIN_ELAPSED_S
            ? Math.round((blinkCountRef.current / windowSec) * 60)
            : 0; // show 0 until we have enough data
          latestBlinkRateRef.current = rate;
          setBlinkRate(rate);

          // ── Alerts ───────────────────────────────────────────────────────
          if (stress > 0.7) {
            if (stressHighSinceRef.current === null) stressHighSinceRef.current = Date.now();
            if (Date.now() - stressHighSinceRef.current > 10000 && !alertFiredRef.current) {
              alertFiredRef.current = true;
              setAlertStress(true);
              playBeep(880, 0.3);
            }
          } else {
            stressHighSinceRef.current = null;
            alertFiredRef.current = false;
            setAlertStress(false);
          }

          const elapsed30s = (Date.now() - blinkStartTimeRef.current) > 30000;
          if (elapsed30s && rate < 8 && rate > 0) {
            setAlertBlink(true);
          } else if (rate >= 8) {
            setAlertBlink(false);
          }
        } else {
          latestEmotionRef.current = "neutral";
          latestStressRef.current = 0;
          setEmotion("neutral"); setStressScore(0);
          stressHighSinceRef.current = null;
          alertFiredRef.current = false;
          setAlertStress(false);
        }
      } catch {
        // Skip failed frames silently
      }
    }, 150);
  }, []);

  // ── API loop — POST to backend every 3 s ────────────────────────────────────
  const startApiLoop = useCallback(() => {
    apiIntervalRef.current = setInterval(async () => {
      if (!isRunningRef.current || latestResultsRef.current.length === 0) return;
      try {
        const res = await fetch(`${BACKEND_URL}/api/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            emotion: latestEmotionRef.current,
            stressScore: latestStressRef.current,
            blinkRate: latestBlinkRateRef.current,
            timestamp: new Date().toISOString(),
          }),
        });
        setBackendOk(res.ok);
      } catch {
        setBackendOk(false);
      }
    }, 3000);
  }, []);

  // ── Draw loop — unchanged from Phase 1 + emotion label colour ───────────────
  const startDrawLoop = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

    function draw() {
      if (!isRunningRef.current || !canvas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const results = latestResultsRef.current;
      results.forEach(({ detection, landmarks }) => {
        const box = detection.box;
        const score = detection.score;

        // Bounding box
        ctx.strokeStyle = "#00f5d4";
        ctx.lineWidth = 2;
        ctx.shadowColor = "#00f5d4";
        ctx.shadowBlur = 12;
        ctx.strokeRect(box.x, box.y, box.width, box.height);
        ctx.shadowBlur = 0;

        // Corner accents
        drawCorners(ctx, box.x, box.y, box.width, box.height, 16, "#00f5d4");

        // Confidence + emotion label (un-mirror for correct text rendering)
        const emColor = EMOTION_COLORS[latestEmotionRef.current] ?? "#00f5d4";
        const label = `FACE ${(score * 100).toFixed(1)}%  ${latestEmotionRef.current.toUpperCase()}`;
        ctx.font = "bold 13px monospace";
        const tw = ctx.measureText(label).width;

        ctx.save();
        ctx.scale(-1, 1);
        ctx.translate(-canvas.width, 0);
        const ux = canvas.width - box.x - tw - 12;

        ctx.fillStyle = "rgba(0,0,0,0.75)";
        ctx.fillRect(ux, box.y - 24, tw + 12, 22);
        ctx.fillStyle = emColor;
        ctx.fillText(label, ux + 6, box.y - 7);
        ctx.restore();

        // Landmark groups (unchanged)
        const pts = landmarks.positions;
        drawLandmarkGroup(ctx, pts.slice(0, 17),  "#4cc9f0", false);
        drawLandmarkGroup(ctx, pts.slice(17, 22), "#f72585", false);
        drawLandmarkGroup(ctx, pts.slice(22, 27), "#f72585", false);
        drawLandmarkGroup(ctx, pts.slice(27, 31), "#4cc9f0", false);
        drawLandmarkGroup(ctx, pts.slice(31, 36), "#4cc9f0", false);
        drawLandmarkGroup(ctx, pts.slice(36, 42), "#7209b7", true);
        drawLandmarkGroup(ctx, pts.slice(42, 48), "#7209b7", true);
        drawLandmarkGroup(ctx, pts.slice(48, 60), "#f72585", true);
        drawLandmarkGroup(ctx, pts.slice(60, 68), "#f72585", true);

        // Blink indicator
        if (eyeClosedRef.current) {
          ctx.save();
          ctx.scale(-1, 1);
          ctx.translate(-canvas.width, 0);
          ctx.font = "bold 11px monospace";
          ctx.fillStyle = "#facc15";
          const bx = canvas.width - box.x - box.width + 4;
          ctx.fillText("● BLINK", bx, box.y + box.height + 16);
          ctx.restore();
        }
      });

      // FPS counter
      const now = performance.now();
      fpsRef.current.frames++;
      if (now - fpsRef.current.last >= 1000) {
        setFps(fpsRef.current.frames);
        fpsRef.current.frames = 0;
        fpsRef.current.last = now;
      }

      rafRef.current = requestAnimationFrame(draw);
    }

    rafRef.current = requestAnimationFrame(draw);
  }, []);

  useEffect(() => { return () => { stopCamera(); }; }, [stopCamera]);

  const isRunning = status === "detecting" || status === "no-face";
  const isLoading = status === "loading-models" || status === "requesting-camera";

  const stressPct = Math.round(stressScore * 100);
  const stressColor =
    stressPct >= 70 ? "#ef4444" : stressPct >= 40 ? "#f97316" : "#22c55e";

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-[#0a0a0f] text-white flex flex-col items-center justify-start py-10 px-4" suppressHydrationWarning>

      {/* Header */}
      <header className="mb-8 text-center select-none">
        <div className="flex items-center justify-center gap-3 mb-2">
          <div className="w-2 h-2 rounded-full bg-[#00f5d4] animate-pulse shadow-[0_0_8px_#00f5d4]" />
          <h1 className="text-3xl font-black tracking-[0.15em] uppercase font-mono">
            FACE<span className="text-[#00f5d4]">SENSE</span>
          </h1>
          <div className="w-2 h-2 rounded-full bg-[#00f5d4] animate-pulse shadow-[0_0_8px_#00f5d4]" />
        </div>
        <p className="text-xs text-zinc-600 tracking-widest uppercase font-mono">
          Phase 2 — Emotion · Stress · Blink Detection
        </p>
      </header>

      {/* Alerts */}
      {(alertStress || alertBlink) && (
        <div className="mb-4 w-full max-w-5xl flex flex-col gap-2">
          {alertStress && (
            <div className="flex items-center gap-3 bg-red-950/60 border border-red-500/50 rounded-lg px-4 py-3 text-red-400 text-sm font-mono animate-pulse">
              <span className="text-lg">⚠</span>
              <span>HIGH STRESS DETECTED — sustained stress for 10+ seconds. Take a break.</span>
            </div>
          )}
          {alertBlink && (
            <div className="flex items-center gap-3 bg-amber-950/60 border border-amber-500/50 rounded-lg px-4 py-3 text-amber-400 text-sm font-mono">
              <span className="text-lg">👁</span>
              <span>LOW BLINK RATE ({blinkRate}/min) — blink more often to reduce eye strain.</span>
            </div>
          )}
        </div>
      )}

      {/* Main layout */}
      <div className="w-full max-w-5xl flex flex-col xl:flex-row gap-4">

        {/* Video + Canvas */}
        <div className="relative flex-1">
          <div className={`rounded-xl overflow-hidden border transition-all duration-500 ${
            isRunning
              ? alertStress
                ? "border-red-500/50 shadow-[0_0_40px_rgba(239,68,68,0.2)]"
                : "border-[#00f5d4]/30 shadow-[0_0_40px_rgba(0,245,212,0.1)]"
              : "border-zinc-800"
          }`}>
            <video
              ref={videoRef}
              autoPlay muted playsInline
              className="w-full block bg-zinc-950"
              style={{ transform: "scaleX(-1)", minHeight: "360px" }}
            />
            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{ transform: "scaleX(-1)" }}
            />

            {!isRunning && !isLoading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-950/95 min-h-[360px]">
                <CameraOffIcon />
                <p className="mt-4 text-zinc-600 text-sm font-mono tracking-widest uppercase">
                  Press &ldquo;Start Camera&rdquo; to begin
                </p>
              </div>
            )}

            {isLoading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-950/85 min-h-[360px]">
                <Spinner />
                <p className="mt-4 text-amber-400 text-sm font-mono tracking-widest animate-pulse">
                  {STATUS_LABELS[status]}
                </p>
              </div>
            )}
          </div>

          {isRunning && (
            <div className="absolute top-3 right-3 flex flex-col gap-1.5 items-end pointer-events-none">
              <HudBadge color="#00f5d4" label="FACES" value={String(faceCount)} />
              <HudBadge color="#7209b7" label="FPS"   value={String(fps)} />
            </div>
          )}

          {isRunning && (
            <div className="absolute top-3 left-3 flex items-center gap-1.5 bg-black/60 border border-red-500/30 rounded px-2 py-1 pointer-events-none backdrop-blur-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              <span className="text-red-400 text-xs font-mono font-bold tracking-widest">LIVE</span>
            </div>
          )}
        </div>

        {/* ── Analytics Panel ─────────────────────────────────────────────── */}
        {isRunning && (
          <div className="xl:w-64 flex flex-col gap-3">

            {/* Emotion card */}
            <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-4">
              <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest mb-2">Emotion</p>
              <div className="flex items-center gap-3">
                <span className="text-3xl">{EMOTION_EMOJI[emotion] ?? "😐"}</span>
                <div>
                  <p className="text-lg font-bold font-mono capitalize" style={{ color: EMOTION_COLORS[emotion] ?? "#fff" }}>
                    {emotion}
                  </p>
                  <p className="text-xs text-zinc-600 font-mono">dominant</p>
                </div>
              </div>
            </div>

            {/* Stress card */}
            <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">Stress Level</p>
                <p className="text-sm font-bold font-mono" style={{ color: stressColor }}>{stressPct}%</p>
              </div>
              <div className="w-full h-2.5 bg-zinc-800 rounded-full overflow-hidden">
                <div className="h-full rounded-full transition-all duration-500" style={{ width: `${stressPct}%`, backgroundColor: stressColor }} />
              </div>
              <p className="text-[10px] font-mono text-zinc-600 mt-1.5">
                {stressPct >= 70 ? "HIGH — take a break" : stressPct >= 40 ? "MODERATE" : "LOW — calm"}
              </p>
            </div>

            {/* Blink card */}
            <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-4">
              <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest mb-3">Blink Stats</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-zinc-950/60 rounded-lg p-2 text-center">
                  <p className="text-lg font-bold font-mono text-[#00f5d4]">{blinkRate}</p>
                  <p className="text-[10px] font-mono text-zinc-600">/min</p>
                </div>
                <div className="bg-zinc-950/60 rounded-lg p-2 text-center">
                  <p className="text-lg font-bold font-mono text-[#7209b7]">{blinkCount}</p>
                  <p className="text-[10px] font-mono text-zinc-600">total</p>
                </div>
              </div>
              {alertBlink && <p className="text-[10px] font-mono text-amber-400 mt-2">⚠ Rate too low (&lt;8/min)</p>}
            </div>

            {/* Backend status */}
            <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-3 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{
                backgroundColor: backendOk === null ? "#6b7280" : backendOk ? "#22c55e" : "#ef4444"
              }} />
              <div>
                <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">Backend</p>
                <p className="text-xs font-mono text-zinc-400">
                  {backendOk === null ? "waiting…" : backendOk ? "connected ✓" : "offline (data not saved)"}
                </p>
              </div>
            </div>

          </div>
        )}
      </div>

      {/* Status bar */}
      <div className="mt-4 flex items-center gap-2 font-mono text-xs tracking-widest uppercase">
        <span className={`w-1.5 h-1.5 rounded-full ${isRunning ? "bg-emerald-400 animate-pulse" : "bg-zinc-600"}`} />
        <span className={STATUS_COLORS[status]}>{STATUS_LABELS[status]}</span>
      </div>

      {/* Error */}
      {errorMsg && (
        <div className="mt-3 max-w-xl w-full bg-red-950/40 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm font-mono leading-relaxed">
          ⚠ {errorMsg}
        </div>
      )}

      {/* Buttons */}
      <div className="mt-6 flex gap-4">
        {!isRunning && (
          <button
            onClick={startCamera}
            disabled={isLoading}
            className="px-8 py-3 rounded-lg font-mono font-bold text-sm tracking-widest uppercase bg-[#00f5d4] text-[#0a0a0f] hover:bg-[#00f5d4]/80 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-150 shadow-[0_0_24px_rgba(0,245,212,0.35)]"
          >
            ▶ Start Camera
          </button>
        )}
        {isRunning && (
          <button
            onClick={stopCamera}
            className="px-8 py-3 rounded-lg font-mono font-bold text-sm tracking-widest uppercase bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 active:scale-95 transition-all duration-150"
          >
            ■ Stop Camera
          </button>
        )}
      </div>

      {/* Info cards */}
      <div className="mt-10 grid grid-cols-2 sm:grid-cols-4 gap-3 w-full max-w-2xl text-center">
        {[
          { label: "Detection Model", value: "SSD MobileNet v1" },
          { label: "Emotion Model",   value: "Expression Net" },
          { label: "Landmark Points", value: "68 Points" },
          { label: "Processing",      value: "Client-side" },
        ].map(({ label, value }) => (
          <div key={label} className="bg-zinc-900/60 border border-zinc-800 rounded-lg py-3 px-2">
            <p className="text-[10px] font-mono text-zinc-600 uppercase tracking-widest mb-1">{label}</p>
            <p className="text-sm font-bold font-mono text-zinc-300">{value}</p>
          </div>
        ))}
      </div>

      {/* Legend */}
      {isRunning && (
        <div className="mt-6 flex flex-wrap gap-5 justify-center text-xs font-mono text-zinc-500">
          <LegendDot color="#00f5d4" label="Face Box"    />
          <LegendDot color="#4cc9f0" label="Jaw / Nose"  />
          <LegendDot color="#7209b7" label="Eyes"        />
          <LegendDot color="#f72585" label="Brows / Mouth" />
        </div>
      )}

      <footer className="mt-12 text-zinc-800 text-xs font-mono text-center">
        FaceSense Phase 2 · face-api.js · Emotion · Stress · Blink · Express + MongoDB
      </footer>
    </main>
  );
}

// ─── Audio beep helper ─────────────────────────────────────────────────────────
function playBeep(freq = 880, duration = 0.2) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch {
    // AudioContext not available — skip
  }
}

// ─── Canvas helpers (unchanged from Phase 1) ──────────────────────────────────
function drawCorners(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  size: number, color: string
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.shadowColor = color;
  ctx.shadowBlur = 10;

  const corners: Array<[[number,number],[number,number],[number,number]]> = [
    [[x,       y+size], [x,   y  ], [x+size, y  ]],
    [[x+w-size,y      ], [x+w, y  ], [x+w,   y+size]],
    [[x+w,     y+h-size],[x+w, y+h], [x+w-size,y+h]],
    [[x+size,  y+h    ], [x,   y+h], [x,     y+h-size]],
  ];

  corners.forEach(([[ax,ay],[bx,by],[cx,cy]]) => {
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.lineTo(cx, cy);
    ctx.stroke();
  });
  ctx.shadowBlur = 0;
}

function drawLandmarkGroup(
  ctx: CanvasRenderingContext2D,
  points: faceapi.Point[],
  color: string,
  close: boolean
) {
  if (!points.length) return;

  ctx.beginPath();
  ctx.strokeStyle = color + "70";
  ctx.lineWidth = 1;
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  if (close) ctx.closePath();
  ctx.stroke();

  points.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 5;
    ctx.fill();
    ctx.shadowBlur = 0;
  });
}

// ─── UI sub-components (unchanged from Phase 1) ───────────────────────────────
function CameraOffIcon() {
  return (
    <svg width="52" height="52" viewBox="0 0 52 52" fill="none" className="text-zinc-800">
      <rect x="4" y="14" width="44" height="30" rx="5" stroke="currentColor" strokeWidth="2" />
      <circle cx="26" cy="29" r="8" stroke="currentColor" strokeWidth="2" />
      <path d="M18 14l3-6h10l3 6" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

function Spinner() {
  return <div className="w-9 h-9 rounded-full border-2 border-zinc-800 border-t-amber-400 animate-spin" />;
}

function HudBadge({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div
      className="flex items-center gap-2 bg-black/60 border rounded px-2.5 py-1 font-mono text-xs backdrop-blur-sm"
      style={{ borderColor: color + "50" }}
    >
      <span style={{ color: color + "90" }} className="tracking-widest">{label}</span>
      <span style={{ color }} className="font-bold tabular-nums min-w-[1.5ch] text-right">{value}</span>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}