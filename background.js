// Bumped whenever this file changes. The content script echoes it into the
// toast, so a stale service worker is visible instead of being mistaken for a
// broken feature — content scripts reload from disk on every activation, but
// this worker only updates on a real extension reload.
const SW_BUILD = 'sw-b13';
console.log('Blur & Screenshot service worker build', SW_BUILD);

// An offscreen document survives in whatever build created it and keeps its
// tab-capture lock, so a leftover one poisons recording after every reload.
// Clear it the moment this worker starts.
(async () => {
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
      console.log('Blur & Screenshot: cleared a stale offscreen document');
    }
    await chrome.storage.session.remove('recordingTabId');
  } catch {
    /* nothing to clean up */
  }
})();

async function injectAndToggle(tabId, url) {
  if (url && !/^https?:|^file:/i.test(url)) {
    console.warn('Blur & Screenshot: this page cannot be captured —', url);
    return;
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (err) {
    console.error('Blur & Screenshot: failed to inject content script', err);
  }
}

// ---------------------------------------------------------------------------
// Screenshot pipeline. Everything runs here in the service worker: the page's
// Content-Security-Policy (Instagram's blocks data: images, for one) applies to
// content scripts but not to extension contexts, so the capture never touches
// the page. Blur is done as plain pixel math instead of ctx.filter so it can't
// silently no-op in any context.
// ---------------------------------------------------------------------------

function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
  const bin = atob(dataUrl.slice(comma + 1));
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

// One separable box-blur pass. Three passes approximate a Gaussian closely.
function boxBlurPass(src, dst, w, h, radius, horizontal) {
  const outer = horizontal ? h : w;
  const inner = horizontal ? w : h;
  const stepInner = horizontal ? 4 : w * 4;
  const stepOuter = horizontal ? w * 4 : 4;

  for (let o = 0; o < outer; o++) {
    const base = o * stepOuter;
    let r = 0, g = 0, b = 0, a = 0, count = 0;

    for (let i = -radius; i <= radius; i++) {
      const idx = base + Math.min(inner - 1, Math.max(0, i)) * stepInner;
      r += src[idx]; g += src[idx + 1]; b += src[idx + 2]; a += src[idx + 3];
      count++;
    }

    for (let i = 0; i < inner; i++) {
      const out = base + i * stepInner;
      dst[out] = r / count;
      dst[out + 1] = g / count;
      dst[out + 2] = b / count;
      dst[out + 3] = a / count;

      const addIdx = base + Math.min(inner - 1, i + radius + 1) * stepInner;
      const subIdx = base + Math.max(0, i - radius) * stepInner;
      r += src[addIdx] - src[subIdx];
      g += src[addIdx + 1] - src[subIdx + 1];
      b += src[addIdx + 2] - src[subIdx + 2];
      a += src[addIdx + 3] - src[subIdx + 3];
    }
  }
}

function blurRegion(ctx, x, y, w, h) {
  // Capped: cost scales with radius, and past ~40px the region is already
  // unreadable, so a bigger radius only buys latency.
  const radius = Math.min(40, Math.max(4, Math.round(Math.min(w, h) * 0.12)));
  const image = ctx.getImageData(x, y, w, h);
  const a = image.data;
  const b = new Uint8ClampedArray(a.length);
  for (let pass = 0; pass < 3; pass++) {
    boxBlurPass(a, b, w, h, radius, true);
    boxBlurPass(b, a, w, h, radius, false);
  }
  ctx.putImageData(image, x, y);
}

// Mosaic: average each block and paint it flat. Like the blur, this is plain
// pixel math so it behaves identically in every context.
function pixelateRegion(ctx, x, y, w, h) {
  const block = Math.max(6, Math.round(Math.min(w, h) / 14));
  const image = ctx.getImageData(x, y, w, h);
  const d = image.data;
  for (let by = 0; by < h; by += block) {
    const maxY = Math.min(by + block, h);
    for (let bx = 0; bx < w; bx += block) {
      const maxX = Math.min(bx + block, w);
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = by; yy < maxY; yy++) {
        for (let xx = bx; xx < maxX; xx++) {
          const i = (yy * w + xx) * 4;
          r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
        }
      }
      r /= n; g /= n; b /= n;
      for (let yy = by; yy < maxY; yy++) {
        for (let xx = bx; xx < maxX; xx++) {
          const i = (yy * w + xx) * 4;
          d[i] = r; d[i + 1] = g; d[i + 2] = b;
        }
      }
    }
  }
  ctx.putImageData(image, x, y);
}

async function renderAndSaveScreenshot({ dataUrl, regions, viewportWidth, blurStyle }) {
  const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const scale = viewportWidth > 0 ? canvas.width / viewportWidth : 1;
  console.log('[BlurExt/sw] capture', {
    image: `${canvas.width}x${canvas.height}`,
    viewportWidth,
    scale,
    regionsReceived: regions.length,
  });

  let applied = 0;
  for (const r of regions) {
    const x = Math.max(0, Math.round(r.left * scale));
    const y = Math.max(0, Math.round(r.top * scale));
    const w = Math.min(canvas.width - x, Math.round(r.width * scale));
    const h = Math.min(canvas.height - y, Math.round(r.height * scale));
    if (w <= 0 || h <= 0) {
      console.warn('[BlurExt/sw] skipped region', { r, x, y, w, h });
      continue;
    }
    if (blurStyle === 'pixelate') pixelateRegion(ctx, x, y, w, h);
    else blurRegion(ctx, x, y, w, h);
    applied++;
  }
  console.log('[BlurExt/sw] redacted', applied, 'of', regions.length, 'as', blurStyle);

  const out = await canvas.convertToBlob({ type: 'image/png' });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  await chrome.downloads.download({
    url: await blobToDataUrl(out),
    filename: `blurred-screenshot-${ts}.png`,
    saveAs: false,
  });
  return applied;
}

const OFFSCREEN_URL = 'offscreen.html';

// Note: this service worker can be killed and restarted by Chrome at any
// time (e.g. after ~30s idle), which wipes any plain in-memory variable —
// so recording state can never be tracked in a local flag here. Instead we
// ask the offscreen document itself (which holds the actual MediaRecorder
// and isn't subject to this eviction) whether it's currently busy.
async function offscreenIsRecording() {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'offscreen-get-status', target: 'offscreen' });
    return !!status?.recording;
  } catch {
    return false;
  }
}

// If an offscreen document is left over from a previous session (e.g. a
// recording that never cleanly stopped), it's still running whatever code
// was loaded when it was created — reloading this file doesn't touch it.
// Recreate it whenever it's not actually mid-recording so it always runs
// current code.
async function ensureOffscreenDocument() {
  const hasDoc = await chrome.offscreen.hasDocument();
  if (hasDoc) {
    if (await offscreenIsRecording()) return;
    await chrome.offscreen.closeDocument();
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA', 'BLOBS'],
    justification: 'Recording the active tab with MediaRecorder.',
  });
}

// The offscreen document's listener isn't registered the instant
// createDocument() resolves. Poll it until it answers so no message is ever
// sent into a void.
async function waitForOffscreenReady(attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    try {
      const pong = await chrome.runtime.sendMessage({ type: 'offscreen-ping', target: 'offscreen' });
      if (pong?.ready) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Recorder failed to initialise. Reload the extension and try again.');
}

async function startTabRecording(tabId) {
  // Order matters: getMediaStreamId() reserves a capture lock on the tab, and
  // a reserved-but-never-consumed id leaves that tab permanently locked
  // ("Cannot capture a tab with an active stream"). So get the recorder fully
  // ready FIRST, and only then reserve the stream.
  await ensureOffscreenDocument();
  await waitForOffscreenReady();

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    if (/active stream/i.test(err.message)) {
      throw new Error('This tab still holds a capture lock. Open the page in a new tab and try again.');
    }
    throw err;
  }

  try {
    const ack = await chrome.runtime.sendMessage({
      type: 'offscreen-start-recording',
      target: 'offscreen',
      streamId,
    });
    if (!ack?.started) throw new Error(ack?.error || 'Recorder did not start');
  } catch (err) {
    // Never leave a reserved stream dangling — that is what poisons the tab.
    await chrome.offscreen.closeDocument().catch(() => {});
    throw err;
  }

  // Survives service-worker eviction, unlike a plain variable.
  await chrome.storage.session.set({ recordingTabId: tabId });
}

// The offscreen document can only chrome.runtime.sendMessage, which reaches
// extension contexts but never content scripts — so relay status to the tab.
async function relayToRecordingTab(message) {
  const { recordingTabId } = await chrome.storage.session.get('recordingTabId');
  if (recordingTabId == null) return;
  try {
    await chrome.tabs.sendMessage(recordingTabId, message);
  } catch {
    /* tab closed or navigated away */
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'activate-blur-mode' && tab?.id) {
    injectAndToggle(tab.id, tab.url);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'toggle-blur-mode-active-tab') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      const usable = !!tab?.id && /^https?:|^file:/i.test(tab.url || '');
      if (usable) injectAndToggle(tab.id, tab.url);
      sendResponse({ ok: usable });
    });
    return true;
  }

  if (message?.type === 'capture-screenshot' && sender.tab) {
    const { regions = [], viewportWidth = 0, blurStyle = 'gaussian' } = message;
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }, async (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({ ok: false, error: chrome.runtime.lastError?.message || 'capture failed' });
        return;
      }
      try {
        const applied = await renderAndSaveScreenshot({ dataUrl, regions, viewportWidth, blurStyle });
        sendResponse({ ok: true, applied, build: SW_BUILD });
      } catch (err) {
        sendResponse({ ok: false, error: err.message, build: SW_BUILD });
      }
    });
    return true;
  }

  if (message?.type === 'start-recording' && sender.tab) {
    startTabRecording(sender.tab.id)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === 'stop-recording') {
    // Unawaited sendMessage rejects loudly when no receiver exists; swallow it.
    chrome.runtime
      .sendMessage({ type: 'offscreen-stop-recording', target: 'offscreen' })
      .catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  // chrome.downloads isn't exposed to offscreen documents, so the recorder
  // hands the finished video here to be written to disk.
  if (message?.type === 'save-recording') {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    chrome.downloads.download(
      { url: message.dataUrl, filename: `blurred-recording-${ts}.webm`, saveAs: false },
      (downloadId) => {
        if (chrome.runtime.lastError || downloadId === undefined) {
          sendResponse({ ok: false, error: chrome.runtime.lastError?.message || 'download failed' });
        } else {
          sendResponse({ ok: true });
        }
      }
    );
    return true;
  }

  if (message?.type === 'recording-saved' || message?.type === 'recording-error') {
    relayToRecordingTab(message).catch(() => {});
    // The recorder is finished; drop the document so the next run starts clean.
    chrome.storage.session.remove('recordingTabId').catch(() => {});
    chrome.offscreen.closeDocument().catch(() => {});
  }
});
