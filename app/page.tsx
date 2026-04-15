"use client";

/**
 * FaceSense Phase 3 — Personalized AI · Session Management · Adaptive Thresholds
 *
 * Phase 1 features preserved: ✓ webcam, face detection, canvas rendering, landmarks
 * Phase 2 features preserved: ✓ emotion, stress, blink detection, alerts, backend POST
 *
 * Phase 3 additions:
 *   + User identity (UUID → localStorage)
 *   + Session management (per-camera-run sessionId)
 *   + Baseline calibration (30s window on session start)
 *   + Adaptive thresholds (stressThreshold, blinkThreshold)
 *   + KNN training mode (relaxed / stressed samples)
 *   + KNN classification using Euclidean distance
 *   + Alert cooldown (30s minimum gap)
 *   + API batching (buffer → flush every 5s)
 *   + Input validation + error handling / fallbacks
 */

import { useEffect, useRef, useCallback, useState } from "react";
import type * as FaceAPI from "@vladmandic/face-api";

// @vladmandic/face-api uses browser APIs — must not be imported at module level
// during SSR. We load it lazily inside useEffect (client-only).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let faceapi: any = null;
async function getFaceApi() {
  if (!faceapi) {
    faceapi = await import("@vladmandic/face-api");
  }
  return faceapi;
}

// ─── Types ─────────────────────────────────────────────────────────────────────
type Status =
  | "idle"
  | "loading-models"
  | "models-ready"
  | "requesting-camera"
  | "calibrating"
  | "detecting"
  | "no-face"
  | "error";

const STATUS_LABELS: Record<Status, string> = {
  idle: "Camera Off",
  "loading-models": "Loading Models…",
  "models-ready": "Models Ready",
  "requesting-camera": "Requesting Camera…",
  calibrating: "Calibrating (30s)…",
  detecting: "Detecting Face…",
  "no-face": "No Face Detected",
  error: "Error — See Below",
};

const STATUS_COLORS: Record<Status, string> = {
  idle: "text-zinc-500",
  "loading-models": "text-amber-400",
  "models-ready": "text-sky-400",
  "requesting-camera": "text-amber-400",
  calibrating: "text-purple-400",
  detecting: "text-emerald-400",
  "no-face": "text-orange-400",
  error: "text-red-400",
};

type FaceResult = {
  detection: FaceAPI.FaceDetection;
  landmarks: FaceAPI.FaceLandmarks68;
  expressions: FaceAPI.FaceExpressions;
  descriptor?: Float32Array;
};

type TrainLabel = "relaxed" | "stressed";
type TrainPhase = "idle" | "relaxed" | "stressed" | "done";

type KNNSample = {
  descriptor: number[];
  label: TrainLabel;
};

type Baseline = {
  avgStress: number;
  avgBlinkRate: number;
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
  angry: "😠", disgusted: "🤢", fearful: "😨",
  sad: "😢", surprised: "😲", neutral: "😐", happy: "😊",
};

const EMOTION_COLORS: Record<string, string> = {
  angry: "#ef4444", disgusted: "#a855f7", fearful: "#f97316",
  sad: "#3b82f6", surprised: "#eab308", neutral: "#6b7280", happy: "#22c55e",
};

const EAR_THRESHOLD = 0.22;  // 0.25 was too high — caught partial eye movements as blinks
const MIN_BLINK_GAP_MS = 500;  // minimum ms between blinks to prevent overcounting
const BLINK_CONSEC_FRAMES = 2;
const CALIBRATION_DURATION_MS = 30000;
const ALERT_COOLDOWN_MS = 30000;
const BATCH_INTERVAL_MS = 5000;
const TRAIN_SAMPLES_NEEDED = 25;
const KNN_K = 3;

// Phase 2 fallback thresholds
const FALLBACK_STRESS_THRESHOLD = 0.7;
const FALLBACK_BLINK_THRESHOLD = 8;

// ─── Utility functions ─────────────────────────────────────────────────────────
function euclidean(a: FaceAPI.Point, b: FaceAPI.Point) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function euclideanDesc(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

function eyeAspectRatio(pts: FaceAPI.Point[]): number {
  // Vertical distances between upper and lower lid pairs
  const A = euclidean(pts[1], pts[5]);
  const B = euclidean(pts[2], pts[4]);
  // Horizontal distance — use absolute value to handle both eye orientations
  // (left eye: pts[0]=outer, pts[3]=inner; right eye order is mirrored in face-api)
  const C = Math.abs(euclidean(pts[0], pts[3]));
  if (C === 0) return 0;
  return (A + B) / (2.0 * C);
}

function mapEmotionToStress(expressions: FaceAPI.FaceExpressions): number {
  let score = 0;
  const exprObj = expressions as unknown as Record<string, number>;
  for (const [emotion, weight] of Object.entries(STRESS_WEIGHTS)) {
    score += (exprObj[emotion] ?? 0) * weight;
  }
  return Math.min(1, score);
}

function dominantEmotion(expressions: FaceAPI.FaceExpressions): string {
  const exprObj = expressions as unknown as Record<string, number>;
  return Object.entries(exprObj).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

// ─── KNN Classifier ────────────────────────────────────────────────────────────
function knnPredict(
  samples: KNNSample[],
  query: number[],
  k: number = KNN_K
): TrainLabel | null {
  if (samples.length < k) return null;
  const distances = samples.map((s) => ({
    label: s.label,
    dist: euclideanDesc(s.descriptor, query),
  }));
  distances.sort((a, b) => a.dist - b.dist);
  const nearest = distances.slice(0, k);
  const votes: Record<string, number> = {};
  for (const n of nearest) votes[n.label] = (votes[n.label] || 0) + 1;
  return (Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0]) as TrainLabel;
}

// ─── User identity helpers ─────────────────────────────────────────────────────
function getOrCreateUserId(): string {
  if (typeof window === "undefined") return "server";
  let id = localStorage.getItem("facesense_userId");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("facesense_userId", id);
  }
  return id;
}

function generateSessionId(): string {
  return crypto.randomUUID();
}

// ─── Backend URL ───────────────────────────────────────────────────────────────
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

  // Identity / session
  const userIdRef = useRef<string>("");
  const sessionIdRef = useRef<string>("");

  // Blink tracking
  const blinkCountRef = useRef(0);
  const blinkConsecRef = useRef(0);
  const blinkStartTimeRef = useRef<number>(Date.now());
  const lastBlinkTimeRef = useRef<number>(0); // for MIN_BLINK_GAP_MS enforcement
  const eyeClosedRef = useRef(false);

  // Alert tracking with cooldown
  const stressHighSinceRef = useRef<number | null>(null);
  const alertFiredRef = useRef(false);
  const lastAlertTimeRef = useRef<number>(0);

  // Latest analytics refs
  const latestEmotionRef = useRef("neutral");
  const latestStressRef = useRef(0);
  const latestBlinkRateRef = useRef(0);
  const latestDescriptorRef = useRef<number[] | null>(null);

  // Calibration
  const calibrationSamplesRef = useRef<{ stress: number; blinkRate: number }[]>([]);
  const calibrationStartRef = useRef<number>(0);
  const isCalibrationDoneRef = useRef(false);

  // Adaptive thresholds
  const stressThresholdRef = useRef(FALLBACK_STRESS_THRESHOLD);
  const blinkThresholdRef = useRef(FALLBACK_BLINK_THRESHOLD);

  // API batch buffer
  const batchBufferRef = useRef<object[]>([]);

  // KNN training state
  const knnSamplesRef = useRef<KNNSample[]>([]);
  const trainingCountRef = useRef(0);

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

  // Phase 3 UI state
  const [calibProgress, setCalibProgress] = useState(0);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [knnPrediction, setKnnPrediction] = useState<TrainLabel | null>(null);
  const [trainPhase, setTrainPhase] = useState<TrainPhase>("idle");
  const [trainCount, setTrainCount] = useState(0);
  const [modelReady, setModelReady] = useState(false);
  const [showTrainingPanel, setShowTrainingPanel] = useState(false);
  const [userId, setUserId] = useState<string>("");

  const fpsRef = useRef({ frames: 0, last: performance.now() });

  // ── Initialise user identity ──────────────────────────────────────────────
  useEffect(() => {
    const id = getOrCreateUserId();
    userIdRef.current = id;
    setUserId(id);

    // Try to load user's KNN model from backend
    fetch(`${BACKEND_URL}/api/usermodel/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.samples && data.samples.length >= KNN_K * 2) {
          knnSamplesRef.current = data.samples;
          setModelReady(true);
        }
      })
      .catch(() => {/* offline — ok */});

    // Try to load baseline
    fetch(`${BACKEND_URL}/api/baseline/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.baseline) {
          setBaseline({ avgStress: data.baseline.avgStress, avgBlinkRate: data.baseline.avgBlinkRate });
          stressThresholdRef.current = data.stressThreshold ?? FALLBACK_STRESS_THRESHOLD;
          blinkThresholdRef.current = data.blinkThreshold ?? FALLBACK_BLINK_THRESHOLD;
        }
      })
      .catch(() => {/* offline — use fallbacks */});
  }, []);

  // ── Load models ───────────────────────────────────────────────────────────
  const loadModels = useCallback(async () => {
    if (modelsLoadedRef.current) return;
    setStatus("loading-models");
    setErrorMsg("");
    try {
      faceapi = await getFaceApi();
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri("/models"),
        faceapi.nets.faceLandmark68Net.loadFromUri("/models"),
        faceapi.nets.faceExpressionNet.loadFromUri("/models"),
        faceapi.nets.faceRecognitionNet.loadFromUri("/models"),
      ]);
      modelsLoadedRef.current = true;
      setStatus("models-ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setErrorMsg(`Model load failed: ${msg}. Run: node scripts/download-models.js`);
      setStatus("error");
    }
  }, []);

  // ── Start camera ──────────────────────────────────────────────────────────
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

      // New session ID
      sessionIdRef.current = generateSessionId();

      // Reset blink/stress/calibration state
      blinkCountRef.current = 0;
      blinkConsecRef.current = 0;
      blinkStartTimeRef.current = Date.now();
      lastBlinkTimeRef.current = 0;
      eyeClosedRef.current = false;
      stressHighSinceRef.current = null;
      alertFiredRef.current = false;
      lastAlertTimeRef.current = 0;
      batchBufferRef.current = [];
      calibrationSamplesRef.current = [];
      calibrationStartRef.current = Date.now();
      isCalibrationDoneRef.current = false;
      setCalibProgress(0);

      isRunningRef.current = true;
      setStatus("calibrating");
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

  // ── Stop camera ───────────────────────────────────────────────────────────
  const stopCamera = useCallback(() => {
    isRunningRef.current = false;

    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (inferIntervalRef.current !== null) { clearInterval(inferIntervalRef.current); inferIntervalRef.current = null; }
    if (apiIntervalRef.current !== null) { clearInterval(apiIntervalRef.current); apiIntervalRef.current = null; }
    latestResultsRef.current = [];

    // Flush remaining buffer
    if (batchBufferRef.current.length > 0) {
      flushBatch(batchBufferRef.current.splice(0));
    }

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
    setCalibProgress(0);
    setStatus("idle"); setErrorMsg("");
  }, []);

  // ── Calibration finalization ───────────────────────────────────────────────
  const finalizeCalibration = useCallback((samples: { stress: number; blinkRate: number }[]) => {
    if (samples.length < 5) return;
    const avgStress = samples.reduce((s, x) => s + x.stress, 0) / samples.length;
    const avgBlinkRate = samples.reduce((s, x) => s + x.blinkRate, 0) / samples.length;

    const newBaseline: Baseline = { avgStress, avgBlinkRate };
    setBaseline(newBaseline);
    stressThresholdRef.current = Math.min(0.95, avgStress + 0.2);
    blinkThresholdRef.current = avgBlinkRate * 0.7;

    // Save to backend (non-blocking)
    fetch(`${BACKEND_URL}/api/baseline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: userIdRef.current,
        avgStress,
        avgBlinkRate,
        sampleCount: samples.length,
      }),
    }).catch(() => {/* offline */});
  }, []);

  // ── API batch flush ────────────────────────────────────────────────────────
  const flushBatch = useCallback(async (items: object[]) => {
    if (items.length === 0) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(items),
      });
      setBackendOk(res.ok);
    } catch {
      setBackendOk(false);
    }
  }, []);

  // ── Inference loop ─────────────────────────────────────────────────────────
  const startInferenceLoop = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    inferIntervalRef.current = setInterval(async () => {
      if (!isRunningRef.current || !video || video.paused || video.ended) return;

      try {
        const detections = await faceapi
          .detectAllFaces(video, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
          .withFaceLandmarks()
          .withFaceExpressions()
          .withFaceDescriptors();

        const displaySize = { width: video.videoWidth, height: video.videoHeight };
        const resized = faceapi.resizeResults(detections, displaySize) as FaceResult[];
        latestResultsRef.current = resized;

        setFaceCount(resized.length);

        // Calibration phase
        const now = Date.now();
        const elapsed = now - calibrationStartRef.current;

        if (!isCalibrationDoneRef.current) {
          const pct = Math.min(100, Math.round((elapsed / CALIBRATION_DURATION_MS) * 100));
          setCalibProgress(pct);

          if (elapsed >= CALIBRATION_DURATION_MS) {
            isCalibrationDoneRef.current = true;
            finalizeCalibration(calibrationSamplesRef.current);
            setStatus(resized.length === 0 ? "no-face" : "detecting");
          }
        } else {
          setStatus(resized.length === 0 ? "no-face" : "detecting");
        }

        if (resized.length > 0) {
          const first = resized[0];

          // ── Emotion & Stress ────────────────────────────────────────────
          const dom = dominantEmotion(first.expressions);
          const stress = mapEmotionToStress(first.expressions);
          latestEmotionRef.current = dom;
          latestStressRef.current = stress;
          setEmotion(dom);
          setStressScore(Math.round(stress * 100) / 100);

          // ── Descriptor (for KNN) ────────────────────────────────────────
          if (first.descriptor) {
            const desc = Array.from(first.descriptor);
            latestDescriptorRef.current = desc;

            // KNN prediction if model ready
            if (knnSamplesRef.current.length >= KNN_K * 2) {
              const pred = knnPredict(knnSamplesRef.current, desc);
              setKnnPrediction(pred);
            }

            // Capture training sample if in training mode
            if (trainPhaseRef.current !== "idle" && trainPhaseRef.current !== "done") {
              const label = trainPhaseRef.current as TrainLabel;
              if (trainingCountRef.current < TRAIN_SAMPLES_NEEDED) {
                trainingCountRef.current++;
                knnSamplesRef.current.push({ descriptor: desc, label });
                setTrainCount(trainingCountRef.current);
                if (trainingCountRef.current >= TRAIN_SAMPLES_NEEDED) {
                  trainPhaseRef.current = "done";
                  setTrainPhase("done");
                }
              }
            }
          }

          // ── Blink (EAR) ─────────────────────────────────────────────────
          const pts = first.landmarks.positions;
          const leftEye = pts.slice(36, 42);
          const rightEye = pts.slice(42, 48);
          const ear = (eyeAspectRatio(leftEye) + eyeAspectRatio(rightEye)) / 2;

          if (ear < EAR_THRESHOLD) {
            eyeClosedRef.current = true;
            blinkConsecRef.current++;
          } else {
            if (blinkConsecRef.current >= BLINK_CONSEC_FRAMES) {
              // Only count as a blink if enough time has passed since the last one.
              // Without this, a single slow blink (EAR stays low across many frames)
              // can fire multiple counts as blinkConsecRef resets and rises again.
              const nowBlink = Date.now();
              if (nowBlink - lastBlinkTimeRef.current >= MIN_BLINK_GAP_MS) {
                lastBlinkTimeRef.current = nowBlink;
                blinkCountRef.current++;
                setBlinkCount(blinkCountRef.current);
              }
            }
            blinkConsecRef.current = 0;
            eyeClosedRef.current = false;
          }

          const elapsedMin = (Date.now() - blinkStartTimeRef.current) / 60000;
          const rate = elapsedMin > 0 ? Math.round(blinkCountRef.current / elapsedMin) : 0;
          latestBlinkRateRef.current = rate;
          setBlinkRate(rate);

          // ── Calibration sample collection ───────────────────────────────
          if (!isCalibrationDoneRef.current) {
            calibrationSamplesRef.current.push({ stress, blinkRate: rate });
          }

          // ── Adaptive alerts with cooldown ───────────────────────────────
          const stressThresh = stressThresholdRef.current;
          const blinkThresh = blinkThresholdRef.current;
          const nowMs = Date.now();
          const cooldownOk = (nowMs - lastAlertTimeRef.current) >= ALERT_COOLDOWN_MS;

          if (stress > stressThresh) {
            if (stressHighSinceRef.current === null) stressHighSinceRef.current = nowMs;
            if (nowMs - stressHighSinceRef.current > 10000 && !alertFiredRef.current && cooldownOk) {
              alertFiredRef.current = true;
              lastAlertTimeRef.current = nowMs;
              setAlertStress(true);
              playBeep(880, 0.3);
            }
          } else {
            stressHighSinceRef.current = null;
            alertFiredRef.current = false;
            setAlertStress(false);
          }

          // Bug 3 fix: previous logic had a missing else branch — when elapsed30s was
          // false AND rate < blinkThresh, neither branch ran, leaving alertBlink stuck.
          // Also removed the `rate > 0` guard: 0 blinks after 30s still warrants an alert.
          const elapsed30s = (Date.now() - blinkStartTimeRef.current) > 30000;
          if (elapsed30s && rate < blinkThresh) {
            setAlertBlink(true);
          } else {
            setAlertBlink(false);
          }

        } else {
          latestEmotionRef.current = "neutral";
          latestStressRef.current = 0;
          latestDescriptorRef.current = null;
          setEmotion("neutral"); setStressScore(0);
          stressHighSinceRef.current = null;
          alertFiredRef.current = false;
          setAlertStress(false);
          setKnnPrediction(null);
        }
      } catch {
        // Skip failed frames silently
      }
    }, 150);
  }, [finalizeCalibration]);

  // ── API batch loop — flush every 5s ───────────────────────────────────────
  const startApiLoop = useCallback(() => {
    apiIntervalRef.current = setInterval(() => {
      if (!isRunningRef.current) return;

      // Add current snapshot to buffer (even if no face — rate = 0)
      if (userIdRef.current && sessionIdRef.current) {
        batchBufferRef.current.push({
          userId: userIdRef.current,
          sessionId: sessionIdRef.current,
          emotion: latestEmotionRef.current,
          stressScore: latestStressRef.current,
          blinkRate: latestBlinkRateRef.current,
          timestamp: new Date().toISOString(),
        });
      }

      // Flush buffer
      if (batchBufferRef.current.length > 0) {
        flushBatch(batchBufferRef.current.splice(0));
      }
    }, BATCH_INTERVAL_MS);
  }, [flushBatch]);

  // ── Training phase ref (needs to be readable inside interval) ─────────────
  const trainPhaseRef = useRef<TrainPhase>("idle");

  // ── Start training for a label ─────────────────────────────────────────────
  const startTraining = useCallback((label: TrainLabel) => {
    trainingCountRef.current = 0;
    trainPhaseRef.current = label;
    setTrainPhase(label);
    setTrainCount(0);
  }, []);

  // ── Save trained model to backend ─────────────────────────────────────────
  const saveModel = useCallback(async () => {
    if (knnSamplesRef.current.length < KNN_K * 2) return;
    try {
      const res = await fetch(`${BACKEND_URL}/api/usermodel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: userIdRef.current,
          samples: knnSamplesRef.current,
        }),
      });
      if (res.ok) {
        setModelReady(true);
        setTrainPhase("idle");
        trainPhaseRef.current = "idle";
      }
    } catch {
      // offline — model stays in-memory only
      setModelReady(knnSamplesRef.current.length >= KNN_K * 2);
    }
  }, []);

  // ── Clear model ────────────────────────────────────────────────────────────
  const clearModel = useCallback(() => {
    knnSamplesRef.current = [];
    setModelReady(false);
    setKnnPrediction(null);
    setTrainPhase("idle");
    trainPhaseRef.current = "idle";
    fetch(`${BACKEND_URL}/api/usermodel/${userIdRef.current}`, { method: "DELETE" }).catch(() => {});
  }, []);

  // ── Draw loop ──────────────────────────────────────────────────────────────
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
        const rawBox = detection.box;
        const score = detection.score;

        // Expand the face-api bounding box to cover the full head including hair.
        // face-api boxes only wrap the detected landmarks (chin to forehead hairline)
        // so we pad: 30% extra height upward (for hair/forehead), 10% on sides.
        const padX = rawBox.width * 0.10;
        const padYTop = rawBox.height * 0.30;
        const padYBot = rawBox.height * 0.05;
        const box = {
          x: Math.max(0, rawBox.x - padX),
          y: Math.max(0, rawBox.y - padYTop),
          width: rawBox.width + padX * 2,
          height: rawBox.height + padYTop + padYBot,
        };

        // The canvas element has CSS scaleX(-1) applied, which mirrors the entire
        // canvas visually. All drawing uses the raw (un-mirrored) landmark/box
        // coordinates from face-api — the CSS transform handles the visual flip.
        // For text we must counter-flip (scale -1 / translate) so it reads correctly.

        const emColor = EMOTION_COLORS[latestEmotionRef.current] ?? "#00f5d4";
        const label = `FACE ${(score * 100).toFixed(1)}%  ${latestEmotionRef.current.toUpperCase()}`;
        ctx.font = "bold 13px monospace";
        const tw = ctx.measureText(label).width;

        // Draw the padded bounding box
        ctx.save();
        ctx.strokeStyle = emColor + "cc";
        ctx.lineWidth = 2;
        ctx.shadowColor = emColor;
        ctx.shadowBlur = 8;
        ctx.strokeRect(box.x, box.y, box.width, box.height);
        ctx.shadowBlur = 0;
        ctx.restore();

        // Label: counter-flip text so it reads correctly under CSS scaleX(-1).
        // Visual left edge of box after CSS flip = canvas.width - box.x - box.width
        ctx.save();
        ctx.scale(-1, 1);
        ctx.translate(-canvas.width, 0);
        const labelX = canvas.width - box.x - box.width;
        ctx.fillStyle = "rgba(0,0,0,0.75)";
        ctx.fillRect(labelX, box.y - 24, tw + 12, 22);
        ctx.fillStyle = emColor;
        ctx.fillText(label, labelX + 6, box.y - 7);
        ctx.restore();

        // Use original landmark coordinates — CSS scaleX(-1) on canvas handles the mirror
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

        if (eyeClosedRef.current) {
          ctx.save();
          ctx.scale(-1, 1);
          ctx.translate(-canvas.width, 0);
          ctx.font = "bold 11px monospace";
          ctx.fillStyle = "#facc15";
          // Use same mirror formula as the label: canvas.width - box.x - box.width
          const blinkLabelX = canvas.width - box.x - box.width + 4;
          ctx.fillText("● BLINK", blinkLabelX, box.y + box.height + 16);
          ctx.restore();
        }
      });

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

  const isRunning = status === "detecting" || status === "no-face" || status === "calibrating";
  const isLoading = status === "loading-models" || status === "requesting-camera";
  const isCalibrating = status === "calibrating";

  const stressPct = Math.round(stressScore * 100);
  const stressColor =
    stressPct >= Math.round(stressThresholdRef.current * 100)
      ? "#ef4444"
      : stressPct >= 40 ? "#f97316" : "#22c55e";

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <main className="min-h-screen bg-[#0a0a0f] text-white flex flex-col items-center justify-start py-10 px-4">

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
          Phase 3 — Personalized AI · Adaptive Thresholds · KNN
        </p>
        {userId && (
          <p className="text-[10px] text-zinc-700 font-mono mt-1">
            User: {userId.slice(0, 8)}…
          </p>
        )}
      </header>

      {/* Calibration bar */}
      {isCalibrating && (
        <div className="mb-4 w-full max-w-5xl">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-mono text-purple-400">Calibrating baseline…</span>
            <span className="text-xs font-mono text-purple-300">{calibProgress}%</span>
          </div>
          <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ width: `${calibProgress}%`, backgroundColor: "#a855f7" }}
            />
          </div>
          <p className="text-[10px] font-mono text-zinc-600 mt-1">
            Sit relaxed — we are learning your baseline stress and blink patterns
          </p>
        </div>
      )}

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
                : isCalibrating
                  ? "border-purple-500/40 shadow-[0_0_40px_rgba(168,85,247,0.15)]"
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
              {modelReady && knnPrediction && (
                <HudBadge
                  color={knnPrediction === "stressed" ? "#ef4444" : "#22c55e"}
                  label="KNN"
                  value={knnPrediction.toUpperCase()}
                />
              )}
            </div>
          )}

          {isRunning && (
            <div className="absolute top-3 left-3 flex items-center gap-1.5 bg-black/60 border border-red-500/30 rounded px-2 py-1 pointer-events-none backdrop-blur-sm">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
              <span className="text-red-400 text-xs font-mono font-bold tracking-widest">LIVE</span>
            </div>
          )}
        </div>

        {/* ── Analytics Panel ──────────────────────────────────────────────── */}
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
              <div className="flex justify-between mt-1">
                <p className="text-[10px] font-mono text-zinc-600">
                  {stressPct >= Math.round(stressThresholdRef.current * 100) ? "HIGH — take a break" : stressPct >= 40 ? "MODERATE" : "LOW — calm"}
                </p>
                {baseline && (
                  <p className="text-[10px] font-mono text-purple-500">
                    thresh: {Math.round(stressThresholdRef.current * 100)}%
                  </p>
                )}
              </div>
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
              {baseline && (
                <p className="text-[10px] font-mono text-purple-500 mt-1">
                  threshold: {Math.round(blinkThresholdRef.current)}/min
                </p>
              )}
              {alertBlink && <p className="text-[10px] font-mono text-amber-400 mt-1">⚠ Rate too low</p>}
            </div>

            {/* KNN prediction card */}
            {modelReady && (
              <div className="bg-zinc-900/70 border border-zinc-800 rounded-xl p-3">
                <p className="text-[10px] font-mono text-zinc-500 uppercase tracking-widest mb-1">KNN Prediction</p>
                {knnPrediction ? (
                  <p className="text-sm font-bold font-mono" style={{ color: knnPrediction === "stressed" ? "#ef4444" : "#22c55e" }}>
                    {knnPrediction === "stressed" ? "😰 STRESSED" : "😌 RELAXED"}
                  </p>
                ) : (
                  <p className="text-xs font-mono text-zinc-600">waiting for face…</p>
                )}
              </div>
            )}

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

      {/* Training panel toggle */}
      {isRunning && !isCalibrating && (
        <div className="mt-4 w-full max-w-5xl">
          <button
            onClick={() => setShowTrainingPanel(!showTrainingPanel)}
            className="text-xs font-mono text-purple-400 border border-purple-500/30 rounded px-3 py-1.5 hover:bg-purple-500/10 transition-colors"
          >
            {showTrainingPanel ? "▲ Hide" : "▼ Show"} Training Panel
          </button>

          {showTrainingPanel && (
            <div className="mt-3 bg-zinc-900/70 border border-zinc-800 rounded-xl p-4">
              <p className="text-xs font-mono text-zinc-400 font-bold mb-3 uppercase tracking-widest">
                KNN Training Mode
              </p>

              {trainPhase === "idle" && (
                <div className="flex flex-col gap-3">
                  <p className="text-xs font-mono text-zinc-500">
                    Train a personalized model. Make a relaxed face, then a stressed face.
                    The system captures {TRAIN_SAMPLES_NEEDED} samples per label.
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => startTraining("relaxed")}
                      className="px-4 py-2 text-xs font-mono font-bold rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                    >
                      😌 Start Relaxed
                    </button>
                    <button
                      onClick={() => startTraining("stressed")}
                      className="px-4 py-2 text-xs font-mono font-bold rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20 transition-colors"
                    >
                      😰 Start Stressed
                    </button>
                    {modelReady && (
                      <button
                        onClick={clearModel}
                        className="px-4 py-2 text-xs font-mono font-bold rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-400 hover:bg-zinc-700 transition-colors"
                      >
                        🗑 Clear Model
                      </button>
                    )}
                  </div>
                  {modelReady && (
                    <p className="text-xs font-mono text-emerald-400">
                      ✓ Model ready with {knnSamplesRef.current.length} samples
                    </p>
                  )}
                </div>
              )}

              {(trainPhase === "relaxed" || trainPhase === "stressed") && (
                <div>
                  <p className="text-xs font-mono text-zinc-400 mb-2">
                    Capturing <span className="font-bold" style={{ color: trainPhase === "relaxed" ? "#22c55e" : "#ef4444" }}>
                      {trainPhase.toUpperCase()}
                    </span> samples — hold expression naturally
                  </p>
                  <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden mb-2">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{
                        width: `${Math.round((trainCount / TRAIN_SAMPLES_NEEDED) * 100)}%`,
                        backgroundColor: trainPhase === "relaxed" ? "#22c55e" : "#ef4444",
                      }}
                    />
                  </div>
                  <p className="text-xs font-mono text-zinc-500">{trainCount} / {TRAIN_SAMPLES_NEEDED}</p>
                </div>
              )}

              {trainPhase === "done" && (
                <div className="flex flex-col gap-3">
                  <p className="text-xs font-mono text-emerald-400">
                    ✓ Capture complete! Total samples: {knnSamplesRef.current.length}
                  </p>
                  <div className="flex gap-3">
                    <button
                      onClick={() => { setTrainPhase("idle"); trainPhaseRef.current = "idle"; }}
                      className="px-4 py-2 text-xs font-mono font-bold rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 hover:bg-zinc-700 transition-colors"
                    >
                      + More Training
                    </button>
                    <button
                      onClick={saveModel}
                      className="px-4 py-2 text-xs font-mono font-bold rounded-lg bg-[#00f5d4]/10 border border-[#00f5d4]/30 text-[#00f5d4] hover:bg-[#00f5d4]/20 transition-colors"
                    >
                      💾 Save Model
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

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
          { label: "AI Model",        value: modelReady ? "KNN Ready ✓" : "KNN (untrained)" },
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
          <LegendDot color="#00f5d4" label="Face Box" />
          <LegendDot color="#4cc9f0" label="Jaw / Nose" />
          <LegendDot color="#7209b7" label="Eyes" />
          <LegendDot color="#f72585" label="Brows / Mouth" />
        </div>
      )}

      <footer className="mt-12 text-zinc-800 text-xs font-mono text-center">
        FaceSense Phase 3 · face-api.js · KNN · Adaptive Thresholds · Express + MongoDB
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
    // AudioContext not available
  }
}

// ─── Canvas helpers ────────────────────────────────────────────────────────────
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
    [[x, y+size], [x, y], [x+size, y]],
    [[x+w-size, y], [x+w, y], [x+w, y+size]],
    [[x+w, y+h-size], [x+w, y+h], [x+w-size, y+h]],
    [[x+size, y+h], [x, y+h], [x, y+h-size]],
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
  points: FaceAPI.Point[],
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

// ─── UI sub-components ─────────────────────────────────────────────────────────
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