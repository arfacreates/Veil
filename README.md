# Veil — Blur Before You Share

A Chrome extension that hides parts of a web page — names, numbers, analytics, whole
paragraphs — then lets you screenshot, record, or present with them redacted.

Built for the moment you need to show a dashboard to a client without showing them
*another* client's data.

**Nothing leaves your computer.** No network requests, no analytics, no accounts.

---

## What it does

- **Click to hide.** Click any element on the page and it's covered. Click again to reveal.
- **Capture** — saves a PNG with the redaction burned into the pixels.
- **Record** — records the tab to a WebM, with the redaction baked into the video.
- **Present** — hides the toolbar and locks the blur on, for live screen sharing
  in Google Meet, Zoom, or Teams.
- **Blur or Pixelate** for screenshots.

Screenshots are redacted by real pixel manipulation after capture — the underlying
content is destroyed, not covered by a translucent layer that could be peeled off.

## Install

Not on the Chrome Web Store yet, so it installs as an unpacked extension:

1. Download or clone this repo
2. Open `chrome://extensions`
3. Turn on **Developer mode** (top-right)
4. Click **Load unpacked** and select this folder
5. Pin it from the puzzle-piece icon

Works in Chrome, Edge, Brave, and other Chromium browsers.

## Use

Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> (Mac: <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd>)
on any normal web page, or click the toolbar icon.

Click what you want hidden, then **Capture**, **Record**, or **Present**.
<kbd>Esc</kbd> exits.

### Live screen sharing

Screen sharing transmits whatever your screen renders, so the blur is already applied
on the far end — the other person never receives the underlying data.

Blur what's private, click **Present** (this hides the toolbar so it isn't shared),
*then* start sharing.

> **Verify it before you rely on it.** The blur covers a position on the page. If the
> page reloads or you navigate away, the blur is gone and the real data is on screen.
> Test in a meeting with yourself first.

## How it works

| File | Runs in | Responsible for |
|---|---|---|
| `content.js` | The web page | Toolbar, click-to-select, overlays, region coordinates |
| `background.js` | Service worker | Screen capture, blur/pixelate math, saving files |
| `offscreen.js` | Offscreen document | Video recording |

Two deliberate design decisions, both learned the hard way:

**Image processing happens in the service worker, not the page.** Page Content-Security
Policies (Instagram's, for one) block the extension from handling the captured image
inside the page. The service worker isn't subject to them.

**Blur is hand-written pixel math, not a canvas filter.** `ctx.filter` can silently do
nothing depending on the context it runs in — and a redaction tool that silently does
nothing is worse than useless.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` | Access the page only when you actively invoke it — not background browsing |
| `scripting` | Inject the toolbar and overlays |
| `downloads` | Save the PNG / WebM to your Downloads folder |
| `tabCapture` | Record the tab |
| `offscreen` | Host the recorder (service workers can't use media APIs) |
| `storage` | Remember which tab is recording; cleared when recording ends |

No host permissions are requested, so Chrome never shows a "read all your data on
every website" warning.

## Known limitations

- Browser tabs only — it can't redact desktop applications.
- Pixelate applies to screenshots; recordings always use blur.
- Selections aren't remembered across page reloads or navigation.
- Long recordings are capped so they save reliably — record shorter clips.
- Recording is one tab at a time. If a tab reports an active capture stream,
  close it and use a new one.

## License

MIT — see [LICENSE](LICENSE). Use it, learn from it, change it.
