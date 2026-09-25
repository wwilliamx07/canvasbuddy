// MV3 background. Its only job is to make the toolbar icon open the panel (the UI lives in the
// side panel so long-running work like file indexing survives the user clicking elsewhere, and
// PGlite is not re-booted on every open). Chrome has `sidePanel`; Firefox has `sidebarAction`,
// which has no click behaviour to set, so the action toggles it — inside the click handler,
// because Firefox only opens a sidebar from a user action.
type FirefoxSidebar = { sidebarAction?: { toggle(): Promise<void> } };

const sidebarAction = (chrome as unknown as FirefoxSidebar).sidebarAction;

if (chrome.sidePanel) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err: unknown) => console.error('sidePanel.setPanelBehavior failed:', err));
} else if (sidebarAction) {
  chrome.action.onClicked.addListener(() => {
    sidebarAction.toggle().catch((err: unknown) => console.error('sidebarAction.toggle failed:', err));
  });
}
