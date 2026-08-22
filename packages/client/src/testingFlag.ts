// Gated by a hidden flag, not a role — a host with no permissions system
// can still use this safely. ?testing=1 flips it on and persists to
// localStorage (clean URLs after the first visit); ?testing=0 is the
// explicit off-switch.
//
// storageKey is required, not defaulted: two tracewrite-using apps sharing a
// browser (e.g. several products on localhost during development) must not
// share one flag, so every host picks its own namespaced key.
export function isTestingModeEnabled(storageKey: string): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get("testing") === "1") {
    localStorage.setItem(storageKey, "1");
  } else if (params.get("testing") === "0") {
    localStorage.removeItem(storageKey);
  }
  return localStorage.getItem(storageKey) === "1";
}
