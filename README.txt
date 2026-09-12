BLUR & SCREENSHOT — Chrome Extension
=====================================

Hide names, numbers, paragraphs, or any part of a page, then take a
screenshot or record the screen with those parts redacted.


INSTALL (2 minutes)
-------------------
1. Unzip this folder somewhere permanent — Documents, not Downloads.
   If you move or delete the folder later, the extension stops working.

2. Open Chrome and go to:  chrome://extensions

3. Turn ON "Developer mode" (top-right toggle).

4. Click "Load unpacked" and select this folder.

5. Click the puzzle-piece icon in the toolbar and pin "Blur & Screenshot".

Works in Chrome, Edge, Brave, and other Chromium browsers.


HOW TO USE
----------
1. Open any normal web page (it cannot run on chrome:// pages).

2. Press Ctrl+Shift+K  (Mac: Cmd+Shift+K), or click the extension icon.

3. Click anything you want hidden — text, a name, a number, a chart,
   an image. Click it again to unhide. The toolbar shows how many
   areas you've selected.

4. Choose Blur or Pixelate (screenshots only — recordings always blur).

5. Then either:
     - Capture  -> saves a PNG to your Downloads
     - Record   -> records the tab; press Esc to stop, saves a WebM
     - Present  -> hides the toolbar and locks the blur on, for live
                   screen sharing. Press Esc to exit.

6. Press Esc or click Done to exit. Nothing is changed on the page
   itself, and selections are forgotten when you leave.


LIVE SCREEN SHARING (Google Meet, Zoom, Teams)
----------------------------------------------
Screen sharing transmits whatever your screen is actually showing, so
the blur is already applied on the other person's end — they see the
blurred version, not the real data.

Before a client call:
  1. Open the page and blur what should stay private.
  2. Click "Present" — this hides the toolbar so it isn't shared.
  3. Then start sharing in Meet/Zoom/Teams.

IMPORTANT — check it yourself before you rely on it:
  - Share your screen in a test meeting first and look at the result.
  - The blur covers a specific spot on the page. If the page reloads,
    or you navigate somewhere else, the blur is GONE and the data is
    live on screen. Re-apply it after any navigation.
  - On dashboards that refresh themselves, confirm the blur is still
    sitting over the right thing before you show it to anyone.

Treat it as a helpful cover, not a guarantee. For genuinely sensitive
data, the safe move is still to not put it on screen.


NOTES
-----
- The toolbar hides itself while recording so it stays out of your video.
  Press Esc to stop, or move the mouse to the top-right corner to bring
  it back.

- If recording says "Cannot capture a tab with an active stream", close
  that tab and use a new one. Refreshing the page will not clear it.

- Chrome shows a "Disable developer mode extensions" warning on startup.
  That is normal for extensions installed this way, not a problem with
  this one. You can dismiss it.

- Long recordings are capped so they can be saved reliably. Record in
  shorter clips.


PRIVACY
-------
This extension makes no network requests of any kind. Nothing is
uploaded, and there is no analytics or tracking. Screenshots and
recordings are created on your computer and saved straight to your
Downloads folder. The only thing it remembers is which tab is being
recorded, and that is discarded when recording ends.

It only gets access to a page when you actively invoke it with the
shortcut or the toolbar icon — it is not running in the background on
your browsing.
