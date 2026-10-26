// Runs `handler` whenever the sidebar's `.nav-tab[data-tab="<tabId>"]` button is clicked.
// Delegated from `document` rather than attached to the button itself: renderSidebar()
// (script_lab.js) only builds those buttons after skins.json has been fetched, which is
// usually *after* an island's mount effect has already run — a direct
// querySelector(...)?.addEventListener() at that point finds nothing and silently never fires.
// Returns the matching cleanup function for a useEffect.
export function onNavTabClick(tabId: string, handler: () => void): () => void {
  const listener = (e: MouseEvent) => {
    const tab = (e.target as Element | null)?.closest?.('.nav-tab');
    if (tab instanceof HTMLElement && tab.dataset.tab === tabId) handler();
  };
  document.addEventListener('click', listener);
  return () => document.removeEventListener('click', listener);
}
