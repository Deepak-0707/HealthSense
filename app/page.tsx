"use client";

/**
 * FaceSense Phase 1 — Real-time Face Detection
 *
 * Fixes applied:
 *  1. Mirrored label text — save/restore ctx transform, flip back before drawing text/corners
 *  2. willReadFrequently — pass { willReadFrequently: true } to getContext("2d")
 *  3. Low FPS — decouple inference from rAF; run inference on a fixed interval (100ms = ~10fps cap)
 *     and use rAF only for the draw step, so the UI never blocks
 */

import { useEffect, useRef, useCallback, useState } from "react";
import * as faceapi from "face-api.js";

// ─── Types ────────────────────────────────────────────────────────────────────
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

// Shared type for one detected face result
type FaceResult = {
  detection: faceapi.FaceDetection;
  landmarks: faceapi.FaceLandmarks68;
};

// ─── Component ────────────────────────────────────────────────────────────────
export default function FaceSensePage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // rAF handle for the draw loop
  const rafRef = useRef<number | null>(null);
  // Interval handle for the inference loop
  const inferIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Latest inference results shared between inference loop → draw loop
  const latestResultsRef = useRef<FaceResult[]>([]);

  const modelsLoadedRef = useRef(false);
  const isRunningRef = useRef(false); // used inside callbacks to avoid stale state

  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [faceCount, setFaceCount] = useState(0);
  const [fps, setFps] = useState(0);
  const fpsRef = useRef({ frames: 0, last: performance.now() });

  // ── Load models ───────────────────────────────────────────────────────────
  const loadModels = useCallback(async () => {
    if (modelsLoadedRef.current) return;
    setStatus("loading-models");
    setErrorMsg("");
    try {
      await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri("/models"),
        faceapi.nets.faceLandmark68Net.loadFromUri("/models"),
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

      isRunningRef.current = true;
      setStatus("detecting");
      startInferenceLoop();
      startDrawLoop();
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

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (inferIntervalRef.current !== null) {
      clearInterval(inferIntervalRef.current);
      inferIntervalRef.current = null;
    }
    latestResultsRef.current = [];

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;

    const canvas = canvasRef.current;
    if (canvas) {
      // FIX 2: willReadFrequently — same option used consistently
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx?.clearRect(0, 0, canvas.width, canvas.height);
    }

    setFaceCount(0);
    setFps(0);
    setStatus("idle");
    setErrorMsg("");
  }, []);

  // ── Inference loop (runs on interval, NOT rAF) ────────────────────────────
  // FIX 3: Decoupled from rAF so heavy inference never starves the draw loop.
  // 100 ms interval = max ~10 inference calls/sec, which is plenty for face detection.
  const startInferenceLoop = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    inferIntervalRef.current = setInterval(async () => {
      if (!isRunningRef.current || !video || video.paused || video.ended) return;

      try {
        const detections = await faceapi
          .detectAllFaces(video, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
          .withFaceLandmarks();

        const displaySize = { width: video.videoWidth, height: video.videoHeight };
        latestResultsRef.current = faceapi.resizeResults(
          detections,
          displaySize
        ) as FaceResult[];

        // Update React state (cheap — only face count changes)
        setFaceCount(latestResultsRef.current.length);
        setStatus(latestResultsRef.current.length === 0 ? "no-face" : "detecting");
      } catch {
        // Silently skip frames that fail (e.g. video not ready yet)
      }
    }, 100); // 10 fps inference cap — smooth enough, CPU-friendly
  }, []);

  // ── Draw loop (runs on rAF — smooth 60fps canvas redraws) ─────────────────
  const startDrawLoop = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    // FIX 2: Pass willReadFrequently so the browser optimises the backing store
    // for frequent pixel reads (face-api.js reads pixel data internally).
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;

    function draw() {
      if (!isRunningRef.current || !canvas) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const results = latestResultsRef.current;
      results.forEach(({ detection, landmarks }) => {
        const box = detection.box;
        const score = detection.score;

        // ── Bounding box ─────────────────────────────────────────────────
        ctx.strokeStyle = "#00f5d4";
        ctx.lineWidth = 2;
        ctx.shadowColor = "#00f5d4";
        ctx.shadowBlur = 12;
        ctx.strokeRect(box.x, box.y, box.width, box.height);
        ctx.shadowBlur = 0;

        // ── Corner accents ───────────────────────────────────────────────
        drawCorners(ctx, box.x, box.y, box.width, box.height, 16, "#00f5d4");

        // ── FIX 1: Confidence label — un-mirror canvas before drawing text
        //
        // The canvas has CSS transform: scaleX(-1) to mirror the video.
        // That makes text appear backwards.  Solution: before drawing the label,
        // flip the canvas CTM back to normal for just that draw call, then restore.
        //
        // The label is placed at the TOP-LEFT of the bounding box.
        // In the mirrored canvas coordinate space, box.x is already the correct
        // visual left edge — we just need to un-mirror around the canvas centre
        // for the text drawing operation only.
        const label = `FACE  ${(score * 100).toFixed(1)}%`;
        ctx.font = "bold 13px monospace";
        const tw = ctx.measureText(label).width;
        const lx = box.x;  // label x in canvas coords
        const ly = box.y;  // label y in canvas coords

        ctx.save();
        // Flip horizontally around the canvas centre so text appears correct
        // in the mirrored CSS view
        ctx.scale(-1, 1);
        ctx.translate(-canvas.width, 0);

        // In the un-mirrored space, the x position of the label becomes:
        const ux = canvas.width - lx - tw - 12; // mirror of lx

        ctx.fillStyle = "rgba(0,0,0,0.72)";
        ctx.fillRect(ux, ly - 24, tw + 12, 22);
        ctx.fillStyle = "#00f5d4";
        ctx.fillText(label, ux + 6, ly - 7);
        ctx.restore();

        // ── Landmark groups (drawn in normal mirrored coords — no text) ──
        const pts = landmarks.positions;
        drawLandmarkGroup(ctx, pts.slice(0, 17),  "#4cc9f0", false); // jaw
        drawLandmarkGroup(ctx, pts.slice(17, 22), "#f72585", false); // left brow
        drawLandmarkGroup(ctx, pts.slice(22, 27), "#f72585", false); // right brow
        drawLandmarkGroup(ctx, pts.slice(27, 31), "#4cc9f0", false); // nose bridge
        drawLandmarkGroup(ctx, pts.slice(31, 36), "#4cc9f0", false); // nose tip
        drawLandmarkGroup(ctx, pts.slice(36, 42), "#7209b7", true);  // left eye
        drawLandmarkGroup(ctx, pts.slice(42, 48), "#7209b7", true);  // right eye
        drawLandmarkGroup(ctx, pts.slice(48, 60), "#f72585", true);  // outer mouth
        drawLandmarkGroup(ctx, pts.slice(60, 68), "#f72585", true);  // inner mouth
      });

      // FPS counter — counts draw frames (reflects actual visual update rate)
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

  // Cleanup on unmount
  useEffect(() => { return () => { stopCamera(); }; }, [stopCamera]);

  const isRunning = status === "detecting" || status === "no-face";
  const isLoading = status === "loading-models" || status === "requesting-camera";

  // ── Render ────────────────────────────────────────────────────────────────
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
          Phase 1 — Real-time Face Detection
        </p>
      </header>

      {/* Video + Canvas */}
      <div className="relative w-full max-w-3xl">
        <div className={`rounded-xl overflow-hidden border transition-all duration-500 ${
          isRunning
            ? "border-[#00f5d4]/30 shadow-[0_0_40px_rgba(0,245,212,0.1)]"
            : "border-zinc-800"
        }`}>
          <video
            ref={videoRef}
            autoPlay muted playsInline
            className="w-full block bg-zinc-950"
            style={{ transform: "scaleX(-1)", minHeight: "360px" }}
          />
          {/*
           * Canvas is absolutely positioned on top of the video.
           * Both share scaleX(-1) so drawings register correctly on the mirrored video.
           * Text is re-flipped per-label inside the draw loop (Fix 1).
           */}
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ transform: "scaleX(-1)" }}
          />

          {/* Idle placeholder */}
          {!isRunning && !isLoading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-950/95 min-h-[360px]">
              <CameraOffIcon />
              <p className="mt-4 text-zinc-600 text-sm font-mono tracking-widest uppercase">
                Press &ldquo;Start Camera&rdquo; to begin
              </p>
            </div>
          )}

          {/* Loading overlay */}
          {isLoading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-950/85 min-h-[360px]">
              <Spinner />
              <p className="mt-4 text-amber-400 text-sm font-mono tracking-widest animate-pulse">
                {STATUS_LABELS[status]}
              </p>
            </div>
          )}
        </div>

        {/* HUD — top right */}
        {isRunning && (
          <div className="absolute top-3 right-3 flex flex-col gap-1.5 items-end pointer-events-none">
            <HudBadge color="#00f5d4" label="FACES" value={String(faceCount)} />
            <HudBadge color="#7209b7" label="FPS"   value={String(fps)} />
          </div>
        )}

        {/* LIVE badge — top left */}
        {isRunning && (
          <div className="absolute top-3 left-3 flex items-center gap-1.5 bg-black/60 border border-red-500/30 rounded px-2 py-1 pointer-events-none backdrop-blur-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-red-400 text-xs font-mono font-bold tracking-widest">LIVE</span>
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
      <div className="mt-10 grid grid-cols-3 gap-4 w-full max-w-xl text-center">
        {[
          { label: "Detection Model", value: "SSD MobileNet v1" },
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
        FaceSense Phase 1 · face-api.js · SSD MobileNet v1 · No backend
      </footer>
    </main>
  );
}

// ─── Canvas drawing helpers ───────────────────────────────────────────────────

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

// ─── UI sub-components ────────────────────────────────────────────────────────

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
