(function () {
  const BUILD = 'b15-failclosed';
  // A stale content script from a previous build would otherwise keep serving
  // its old closure forever; force a swap when the build changes.
  if (window.__blurExtLoaded) {
    if (window.__blurExtBuild === BUILD) {
      window.__blurExtToggle();
      return;
    }
    try { window.__blurExtTeardown && window.__blurExtTeardown(); } catch (e) { /* old build */ }
  }
  window.__blurExtLoaded = true;
  window.__blurExtBuild = BUILD;

  // Older builds had no teardown hook, so their toolbar and overlays can still
  // be sitting in the DOM with live listeners. Two toolbars means clicks land
  // in one instance's state while Capture reads another's — which is how a
  // capture ends up reporting zero regions. Sweep by selector, not by hook.
  const orphans = document.querySelectorAll(
    '#blur-ext-toolbar, #blur-ext-hover-box, #blur-ext-toast, .blur-ext-overlay'
  );
  orphans.forEach((n) => n.remove());
  console.log('[BlurExt] build', BUILD, '| removed', orphans.length, 'orphaned node(s)');

  const state = {
    active: false,
    overlays: new Map(), // targetElement -> overlay div
    toolbar: null,
    hoverBox: null,
    toast: null,
    hoveredEl: null,
    rafPending: false,
    recording: false,
    recordBtn: null,
    recordStartedAt: 0,
    recordTimerId: null,
    blurStyle: 'gaussian',
    presenting: false,
    trackingId: null,
  };

  function isExtUi(el) {
    return !!(el && el.closest && el.closest('#blur-ext-toolbar, #blur-ext-hover-box, #blur-ext-toast, .blur-ext-overlay'));
  }

  function isIgnorable(el) {
    if (!el || !(el instanceof Element)) return true;
    if (el === document.documentElement || el === document.body) return true;
    if (isExtUi(el)) return true;
    return false;
  }

  function buildToolbar() {
    const toolbar = document.createElement('div');
    toolbar.id = 'blur-ext-toolbar';
    toolbar.innerHTML = `
      <span class="blur-ext-label" data-count="0">Click anything to blur it</span>
      <span class="blur-ext-style-group">
        <button type="button" data-style="gaussian" class="blur-ext-style-btn blur-ext-style-active">Blur</button>
        <button type="button" data-style="pixelate" class="blur-ext-style-btn">Pixelate</button>
      </span>
      <button type="button" class="blur-ext-capture" data-action="capture">📸 Capture</button>
      <button type="button" data-action="present">👁 Present</button>
      <button type="button" data-action="record">⏺ Record</button>
      <button type="button" class="blur-ext-clear" data-action="clear">Clear</button>
      <button type="button" class="blur-ext-done" data-action="done">✕ Done</button>
    `;
    toolbar.addEventListener('click', (e) => {
      const styleBtn = e.target.closest('button[data-style]');
      if (styleBtn) {
        state.blurStyle = styleBtn.getAttribute('data-style');
        toolbar.querySelectorAll('.blur-ext-style-btn').forEach((b) => {
          b.classList.toggle('blur-ext-style-active', b === styleBtn);
        });
        return;
      }
      const btn = e.target.closest('button[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      if (action === 'capture') captureNow();
      else if (action === 'present') togglePresenting();
      else if (action === 'record') toggleRecording();
      else if (action === 'clear') clearAllBlurs();
      else if (action === 'done') deactivate();
    });
    document.body.appendChild(toolbar);
    return toolbar;
  }

  function buildHoverBox() {
    const box = document.createElement('div');
    box.id = 'blur-ext-hover-box';
    document.body.appendChild(box);
    return box;
  }

  function buildToast() {
    const toast = document.createElement('div');
    toast.id = 'blur-ext-toast';
    document.body.appendChild(toast);
    return toast;
  }

  function showToast(message) {
    if (!state.toast) return;
    state.toast.textContent = message;
    state.toast.classList.add('blur-ext-toast-show');
    clearTimeout(state.toast._hideTimer);
    state.toast._hideTimer = setTimeout(() => {
      state.toast.classList.remove('blur-ext-toast-show');
    }, 1600);
  }

  function positionBoxToRect(box, rect) {
    box.style.top = `${rect.top}px`;
    box.style.left = `${rect.left}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }

  // Tab capture records whatever the tab renders, so the toolbar would sit in
  // the finished video. During recording it hides, and reappears only while
  // the cursor is in the top-right corner — so it costs a second of footage
  // when you go to stop, instead of the whole clip.
  const REVEAL_W = 300;
  const REVEAL_H = 100;

  function updateRecordingReveal(e) {
    if (!state.toolbar) return;
    const inZone = e.clientX > window.innerWidth - REVEAL_W && e.clientY < REVEAL_H;
    state.toolbar.classList.toggle('blur-ext-reveal', inZone);
  }

  function onMouseMove(e) {
    if (!state.active) return;

    if (state.recording || state.presenting) {
      updateRecordingReveal(e);
      // The dashed hover outline would be filmed too.
      state.hoveredEl = null;
      state.hoverBox.style.display = 'none';
      return;
    }

    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (isIgnorable(el)) {
      state.hoveredEl = null;
      state.hoverBox.style.display = 'none';
      return;
    }
    state.hoveredEl = el;
    const rect = el.getBoundingClientRect();
    positionBoxToRect(state.hoverBox, rect);
    state.hoverBox.style.display = 'block';
  }

  // Live count in the toolbar: if this reads 0 after clicking something, the
  // problem is selection, not capture. Removes a whole class of guesswork.
  function updateLabel() {
    const label = state.toolbar && state.toolbar.querySelector('.blur-ext-label');
    if (!label) return;
    const n = state.overlays.size;
    label.textContent = n === 0 ? 'Click anything to blur it' : `${n} area${n > 1 ? 's' : ''} selected`;
  }

  function toggleBlurOn(el) {
    if (isIgnorable(el)) return;

    if (state.overlays.has(el)) {
      const overlay = state.overlays.get(el);
      overlay.remove();
      state.overlays.delete(el);
      updateLabel();
      return;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;

    const overlay = document.createElement('div');
    overlay.className = 'blur-ext-overlay';
    const cs = window.getComputedStyle(el);
    if (cs.borderRadius && cs.borderRadius !== '0px') {
      overlay.style.borderRadius = cs.borderRadius;
    }
    positionBoxToRect(overlay, rect);
    // Anything added mid-recording or mid-presentation is redacted at full
    // strength too.
    if (state.recording || state.presenting) overlay.classList.add('blur-ext-strong');
    document.body.appendChild(overlay);
    state.overlays.set(el, overlay);
    updateLabel();
  }

  function setOverlayStrength(strong) {
    for (const overlay of state.overlays.values()) {
      overlay.classList.toggle('blur-ext-strong', strong);
    }
  }

  function onClick(e) {
    if (!state.active) return;
    if (isExtUi(e.target)) return; // let toolbar buttons work normally
    // While presenting you are driving a real demo — clicking tabs, filters,
    // links. Swallowing those to toggle a blur would make the page feel
    // broken in front of the client. Set up redactions first; present after.
    if (state.presenting) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    toggleBlurOn(el);
  }

  // Present mode: for live screen sharing (Meet, Zoom, Teams). Screen share
  // transmits whatever the tab renders, so the overlays are already redacted
  // on the far end — but the toolbar would be too. This hides it and holds
  // the blur at recording strength until Esc.
  function togglePresenting() {
    state.presenting = !state.presenting;
    setOverlayStrength(state.presenting || state.recording);
    state.toolbar.classList.toggle('blur-ext-recording-hidden', state.presenting);
    state.toolbar.classList.remove('blur-ext-reveal');
    if (state.presenting) {
      startLiveTracking();
      state.hoverBox.style.display = 'none';
      showToast('Presenting — blurs locked, Esc to exit');
    } else {
      stopLiveTracking();
    }
  }

  function onKeyDown(e) {
    if (!state.active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      // The toolbar is hidden while recording or presenting, so Esc is the
      // way out without putting the cursor (and the toolbar) on screen.
      if (state.presenting) togglePresenting();
      else if (state.recording) toggleRecording();
      else deactivate();
    } else if (e.key === 'Enter' && !state.presenting) {
      // Enter stays out of the way while presenting — you may be typing into
      // the page itself, and firing a screenshot mid-demo is not the intent.
      e.preventDefault();
      captureNow();
    }
  }

  function repositionAll() {
    state.rafPending = false;
    if (!state.active) return;

    // While presenting or recording the audience is watching live, so a
    // redaction must never uncover itself. Pages re-render constantly
    // (dashboards especially) and a covered element can vanish or collapse
    // for a frame — dropping the overlay there would put the real data on
    // screen. In that case the overlay is frozen where it last sat instead.
    const live = state.presenting || state.recording;

    for (const [el, overlay] of state.overlays.entries()) {
      if (!el.isConnected) {
        if (live) continue; // fail closed: keep covering
        overlay.remove();
        state.overlays.delete(el);
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) {
        if (live) continue; // keep the last good position
        overlay.style.display = 'none';
      } else {
        overlay.style.display = 'block';
        positionBoxToRect(overlay, rect);
      }
    }

    if (state.hoveredEl && state.hoveredEl.isConnected) {
      positionBoxToRect(state.hoverBox, state.hoveredEl.getBoundingClientRect());
    }
  }

  // Scroll and resize events don't fire when a page rearranges itself — a
  // live dashboard pushing in new rows moves content under a fixed overlay
  // with no event at all. While presenting or recording, track every frame.
  function startLiveTracking() {
    if (state.trackingId) return;
    const tick = () => {
      if (!state.presenting && !state.recording) {
        state.trackingId = null;
        return;
      }
      repositionAll();
      state.trackingId = requestAnimationFrame(tick);
    };
    state.trackingId = requestAnimationFrame(tick);
  }

  function stopLiveTracking() {
    if (state.trackingId) cancelAnimationFrame(state.trackingId);
    state.trackingId = null;
  }

  function scheduleReposition() {
    if (state.rafPending || !state.active) return;
    state.rafPending = true;
    requestAnimationFrame(repositionAll);
  }

  function clearAllBlurs() {
    for (const overlay of state.overlays.values()) overlay.remove();
    state.overlays.clear();
    updateLabel();
  }

  function formatElapsed(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  function tickRecordTimer() {
    if (!state.recordBtn) return;
    const elapsed = Date.now() - state.recordStartedAt;
    state.recordBtn.textContent = `⏹ Stop ${formatElapsed(elapsed)}`;
  }

  function toggleRecording() {
    if (!state.recording) {
      state.recordBtn.disabled = true;
      state.recordBtn.textContent = 'Starting…';
      chrome.runtime.sendMessage({ type: 'start-recording' }, (response) => {
        state.recordBtn.disabled = false;
        if (response && response.ok) {
          state.recording = true;
          state.recordStartedAt = Date.now();
          setOverlayStrength(true);
          startLiveTracking();
          state.toolbar.classList.add('blur-ext-recording-hidden');
          state.hoverBox.style.display = 'none';
          state.recordBtn.classList.add('blur-ext-recording-active');
          state.recordTimerId = setInterval(tickRecordTimer, 500);
          tickRecordTimer();
          showToast('Recording — press Esc to stop');
        } else {
          state.recordBtn.textContent = '⏺ Record';
          showToast((response && response.error) || 'Recording failed to start');
          console.error('Blur & Screenshot recording error:', response && response.error);
        }
      });
    } else {
      chrome.runtime.sendMessage({ type: 'stop-recording' }).catch(() => {});
      clearInterval(state.recordTimerId);
      state.recordTimerId = null;
      state.recording = false;
      setOverlayStrength(false);
      stopLiveTracking();
      if (state.toolbar) state.toolbar.classList.remove('blur-ext-recording-hidden', 'blur-ext-reveal');
      state.recordBtn.classList.remove('blur-ext-recording-active');
      state.recordBtn.disabled = true;
      state.recordBtn.textContent = 'Saving…';
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'recording-saved') {
      if (state.recordBtn) {
        state.recordBtn.disabled = false;
        state.recordBtn.textContent = '⏺ Record';
        state.recordBtn.classList.remove('blur-ext-recording-active');
      }
      showToast(message.ok === false ? 'Recording failed to save' : 'Recording saved ✓');
    } else if (message?.type === 'recording-error') {
      if (state.recordBtn) {
        state.recordBtn.disabled = false;
        state.recordBtn.textContent = '⏺ Record';
        state.recordBtn.classList.remove('blur-ext-recording-active');
      }
      state.recording = false;
      setOverlayStrength(false);
      stopLiveTracking();
      if (state.toolbar) state.toolbar.classList.remove('blur-ext-recording-hidden', 'blur-ext-reveal');
      clearInterval(state.recordTimerId);
      state.recordTimerId = null;
      showToast('Recording error');
      console.error('Blur & Screenshot recording error:', message.error);
    }
  });

  function captureNow() {
    if (!state.active) return;
    state.toolbar.style.visibility = 'hidden';
    state.hoverBox.style.display = 'none';

    const hiddenOverlays = Array.from(state.overlays.values());
    // Measure the overlay itself, not the source element: the overlay is where
    // the user actually sees the redaction, and it survives the page mutating
    // its own DOM underneath us (React re-renders, feeds, etc).
    const regions = hiddenOverlays
      .map((ov) => {
        const r = ov.getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      })
      .filter((r) => r.width > 0 && r.height > 0);
    for (const overlay of hiddenOverlays) overlay.style.visibility = 'hidden';
    console.log('[BlurExt] sending', regions.length, 'region(s)', regions);

    const restoreUi = () => {
      state.toolbar.style.visibility = 'visible';
      for (const overlay of hiddenOverlays) overlay.style.visibility = 'visible';
    };

    // The page never sees the image: coordinates go out, a saved file comes
    // back. Keeps the whole pipeline clear of the page's CSP.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        chrome.runtime.sendMessage(
          {
            type: 'capture-screenshot',
            regions,
            viewportWidth: window.innerWidth,
            blurStyle: state.blurStyle,
          },
          (response) => {
            restoreUi();
            if (response && response.ok) {
              const build = response.build || 'OLD-WORKER';
              showToast(
                `Saved ✓ — sent ${regions.length}, blurred ${response.applied} [${build}]`
              );
              if (!response.build) {
                console.error(
                  '[BlurExt] The service worker is running an OLD build. Fully reload the extension.'
                );
              }
            } else {
              showToast('Capture failed');
              console.error('Blur & Screenshot capture error:', response && response.error);
            }
          }
        );
      });
    });
  }

  function activate() {
    if (state.active) return;
    state.active = true;
    state.toolbar = buildToolbar();
    state.hoverBox = buildHoverBox();
    state.toast = buildToast();
    state.recordBtn = state.toolbar.querySelector('[data-action="record"]');

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', scheduleReposition, true);
    window.addEventListener('resize', scheduleReposition, true);
  }

  function deactivate() {
    if (!state.active) return;
    state.active = false;
    state.presenting = false;

    if (state.recording) {
      chrome.runtime.sendMessage({ type: 'stop-recording' }).catch(() => {});
      clearInterval(state.recordTimerId);
      state.recordTimerId = null;
      state.recording = false;
      setOverlayStrength(false);
      stopLiveTracking();
      if (state.toolbar) state.toolbar.classList.remove('blur-ext-recording-hidden', 'blur-ext-reveal');
    }

    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', scheduleReposition, true);
    window.removeEventListener('resize', scheduleReposition, true);

    clearAllBlurs();
    state.toolbar?.remove();
    state.hoverBox?.remove();
    state.toast?.remove();
    state.toolbar = null;
    state.hoverBox = null;
    state.toast = null;
    state.hoveredEl = null;
    state.recordBtn = null;
  }

  window.__blurExtToggle = function () {
    if (state.active) deactivate();
    else activate();
  };

  window.__blurExtTeardown = function () {
    deactivate();
    window.__blurExtLoaded = false;
  };

  activate();
})();
