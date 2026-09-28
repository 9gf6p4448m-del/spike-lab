// 在瀏覽器裡逐格跑 MediaPipe PoseLandmarker。影片只在本機解碼，不會送出任何網路請求。
import { FilesetResolver, PoseLandmarker } from '../vendor/vision_bundle.mjs';

const BASE = new URL('../vendor/', import.meta.url).href;
let landmarker = null;
let lastTs = 0;

export async function loadModel(onStatus = () => {}) {
  if (landmarker) return landmarker;
  onStatus('載入姿勢模型…');
  const fileset = await FilesetResolver.forVisionTasks(BASE + 'wasm');
  const model = new Uint8Array(await (await fetch(BASE + 'pose_full.model.wasm')).arrayBuffer());
  let lastErr;
  for (const delegate of ['GPU', 'CPU']) {
    try {
      landmarker = await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: model, delegate },
        runningMode: 'VIDEO',
        numPoses: 4,
        minPoseDetectionConfidence: 0.4,
        minPosePresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });
      landmarker.delegate = delegate;
      return landmarker;
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function seek(video, t) {
  return new Promise((resolve) => {
    const done = () => { video.removeEventListener('seeked', done); resolve(); };
    video.addEventListener('seeked', done);
    video.currentTime = t;
  });
}

// 回傳 { frames, fps, aspect, duration }
export async function analyzeVideo(video, { fps = 30, onProgress = () => {}, signal } = {}) {
  const lm = await loadModel();
  if (video.readyState < 1) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
  const duration = video.duration;
  const aspect = video.videoWidth / video.videoHeight;
  const n = Math.max(1, Math.floor(duration * fps));
  const frames = [];
  for (let i = 0; i < n; i++) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    const t = Math.min(duration - 0.001, i / fps);
    await seek(video, t);
    lastTs = Math.max(lastTs + 1, Math.round(performance.now()));
    const r = lm.detectForVideo(video, lastTs);
    // 畫面裡可能有好幾個人：全部留下，之後由 selectSpiker 追蹤並挑出扣球者
    const people = (r.landmarks ?? []).map((lm, k) => ({
      img: lm.map((p) => [p.x * aspect, p.y, p.z * aspect, p.visibility ?? 1]),
      world: r.worldLandmarks[k].map((p) => [p.x, p.y, p.z]),
    }));
    frames.push({ t, people });
    onProgress(i + 1, n);
  }
  return { frames, fps, aspect, duration };
}
