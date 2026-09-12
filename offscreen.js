let recorder = null;
let chunks = [];
let stream = null;

function pickMimeType() {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

async function startRecording(streamId) {
  if (recorder && recorder.state !== 'inactive') return;

  stream = await navigator.mediaDevices.getUserMedia({
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  stream.getVideoTracks()[0].addEventListener('ended', () => {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  });

  chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: 'video/webm' });
    chunks = [];

    // Offscreen documents only get a narrow slice of the chrome.* APIs —
    // chrome.downloads is not among them, so saving must be done by the
    // service worker. Hand it the bytes as a data: URL (the blob: URL would
    // die with this document before the download finished).
    try {
      if (blob.size === 0) throw new Error('recording was empty');
      // base64 inflates by ~4/3 and the messaging channel has a hard ceiling.
      if (blob.size > 40 * 1024 * 1024) {
        throw new Error(`recording too large to save (${Math.round(blob.size / 1048576)}MB) — record shorter clips`);
      }
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      const res = await chrome.runtime.sendMessage({
        type: 'save-recording',
        dataUrl,
        bytes: blob.size,
      });
      chrome.runtime
        .sendMessage({ type: 'recording-saved', ok: !!res?.ok, error: res?.error })
        .catch(() => {});
    } catch (err) {
      chrome.runtime
        .sendMessage({ type: 'recording-saved', ok: false, error: err.message })
        .catch(() => {});
    }
  };
  // A timeslice makes MediaRecorder flush chunks progressively instead of
  // buffering the whole recording and encoding it all at once on stop().
  recorder.start(1000);
}

function stopRecording() {
  if (recorder && recorder.state !== 'inactive') {
    recorder.stop();
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;

  if (message.type === 'offscreen-ping') {
    sendResponse({ ready: true });
    return;
  }

  if (message.type === 'offscreen-get-status') {
    sendResponse({ recording: !!(recorder && recorder.state !== 'inactive') });
    return;
  }

  if (message.type === 'offscreen-start-recording') {
    startRecording(message.streamId)
      .then(() => sendResponse({ started: true }))
      .catch((err) => {
        if (stream) stream.getTracks().forEach((t) => t.stop());
        sendResponse({ started: false, error: err.message });
      });
    return true; // async sendResponse
  }

  if (message.type === 'offscreen-stop-recording') {
    stopRecording();
    sendResponse({ stopping: true });
  }
});
