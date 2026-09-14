const DEVICE_ID_KEY = "carwash.device_id";
const BRANCH_ID_KEY = "carwash.branch_id";

/** The branch this tablet belongs to. One site today; the key is here anyway. */
export const DEFAULT_BRANCH_ID =
  import.meta.env.VITE_BRANCH_ID ?? "00000000-0000-0000-0000-00000000b1a1";

/**
 * Stable per-tablet identifier, persisted in localStorage. It survives reloads
 * and app updates but not a factory reset or a cleared browser profile — which
 * is the intended behaviour: a device that comes back with a new id shows up
 * in the reconciliation report as a new device rather than silently inheriting
 * the old one's history.
 */
export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = `tablet-${crypto.randomUUID()}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/**
 * Which branch's rows this device writes. Set from the attendant list on first
 * sync, so a tablet provisioned for a second site does not need a rebuild.
 */
export function getBranchId(): string {
  return localStorage.getItem(BRANCH_ID_KEY) ?? DEFAULT_BRANCH_ID;
}

export function setBranchId(branchId: string): void {
  localStorage.setItem(BRANCH_ID_KEY, branchId);
}
