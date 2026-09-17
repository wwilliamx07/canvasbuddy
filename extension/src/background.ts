// MV3 service worker. Its only job is to make the toolbar icon open the side panel
// (the UI lives in the side panel so long-running work like file indexing survives
// the user clicking elsewhere, and PGlite is not re-booted on every open).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err: unknown) => console.error('sidePanel.setPanelBehavior failed:', err));
