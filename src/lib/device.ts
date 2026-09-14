import { newId } from "./ids";

const DEVICE_ID_KEY = "carwash.device_id";
const BRANCH_ID_KEY = "carwash.branch_id";

/** The branch this tablet belongs to. One site today; the key is here anyway. */
export const DEFAULT_BRANCH_ID =
  import.meta.env.VITE_BRANCH_ID ?? "00000000-0000-0000-0000-00000000b1a1";

/**
 * localStorage is not always there.
 *
 * Privacy-hardened browsers, blocked site data and private windows can all
 * make plain `localStorage.getItem` *throw* rather than return null. Both of
 * these functions sit on the path of every wash and every cash count, so an
 * unguarded throw here stopped the POS dead with no message on screen.
 *
 * When storage is unavailable, an in-memory value is used for the session. The
 * consequence is honest and small: the device gets a fresh id when the page
 * reloads, so it shows up in the reconciliation report as a new device rather
 * than silently inheriting the old one's history — which is exactly how a
 * genuinely reset device is meant to behave.
 */
const memory = new Map<string, string>();

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function writeStored(key: string, value: string): void {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    // Held in memory for this session only.
  }
}

/**
 * Stable per-device identifier. It survives reloads and app updates but not a
 * factory reset or a cleared browser profile — which is the intended
 * behaviour: a device that comes back with a new id shows up in the
 * reconciliation report as a new device rather than silently inheriting the
 * old one's history.
 */
export function getDeviceId(): string {
  let id = readStored(DEVICE_ID_KEY);
  if (!id) {
    id = `tablet-${newId()}`;
    writeStored(DEVICE_ID_KEY, id);
  }
  return id;
}

/**
 * Which branch's rows this device writes. Set from the settings row on first
 * sync, so a tablet provisioned for a second site does not need a rebuild.
 */
export function getBranchId(): string {
  return readStored(BRANCH_ID_KEY) ?? DEFAULT_BRANCH_ID;
}

export function setBranchId(branchId: string): void {
  writeStored(BRANCH_ID_KEY, branchId);
}
