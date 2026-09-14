import { db } from "./db";
import type { Attendant, BranchSettings, WashService } from "../types";

/**
 * Demo mode — the app with no backend at all.
 *
 * Everything lives in the phone's own storage: the attendant list, the price
 * list, and every wash logged. Nothing is sent anywhere, because there is
 * nowhere to send it.
 *
 * This exists so the screens can be judged on a real device, in the yard, with
 * wet hands, before anyone signs up for anything. What it CANNOT show you is
 * the half of the system that matters most — the nightly reconciliation, the
 * report, MoMo matching — because all of that runs server-side against data
 * from sources the tablet cannot see. Demo mode tests the tablet, not the
 * business logic. The business logic is tested by `npm test`.
 *
 * Switched on either explicitly with VITE_DEMO_MODE=true, or automatically
 * when no Supabase URL is configured — so a build with no credentials degrades
 * to something usable instead of a blank screen and a console error.
 */
export const DEMO_MODE =
  import.meta.env.VITE_DEMO_MODE === "true" || !import.meta.env.VITE_SUPABASE_URL;

const DEMO_BRANCH = "00000000-0000-0000-0000-00000000b1a1";

/**
 * The same PBKDF2 hashes as supabase/seed.sql, so the demo PINs match the dev
 * PINs and there is one set of numbers to remember. These are public and
 * always have been — they protect nothing here, and a real deployment gets its
 * own hashes from `npm run hash-pin`.
 *
 * PINs: Kofi 1234 · Ama 2345 · Yaw 3456
 */
const DEMO_ATTENDANTS: Attendant[] = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    branch_id: DEMO_BRANCH,
    name: "Kofi Asante",
    pin_hash: "55fb4e5859ddb05bfd8ccfdbab4a629d01909191cdb4ec285f6da3489df373b1",
    pin_salt: "a1b2c3d4e5f60718",
    pin_iterations: 200000,
    active: true
  },
  {
    id: "22222222-2222-2222-2222-222222222222",
    branch_id: DEMO_BRANCH,
    name: "Ama Boateng",
    pin_hash: "205b07ae3e8007ad5d7bdbbbfa966acd37904083d4c49908a7828a672c174aa5",
    pin_salt: "b2c3d4e5f6071829",
    pin_iterations: 200000,
    active: true
  },
  {
    id: "33333333-3333-3333-3333-333333333333",
    branch_id: DEMO_BRANCH,
    name: "Yaw Owusu",
    pin_hash: "93400b70080840be011838a4e1fe4acb9ee5418cf3fe6b9c2dcbb9570960a258",
    pin_salt: "c3d4e5f607182930",
    pin_iterations: 200000,
    active: true
  }
];

const DEMO_SERVICES: WashService[] = [
  { wash_type: "Body wash", price: 25 },
  { wash_type: "Body + interior", price: 45 },
  { wash_type: "Full valet", price: 80 },
  { wash_type: "Engine wash", price: 40 },
  { wash_type: "Underbody wash", price: 35 },
  { wash_type: "Bus / van wash", price: 120 },
  { wash_type: "Motorbike wash", price: 15 }
].map((s, i) => ({
  id: `aaaaaaaa-0000-0000-0000-00000000000${i + 1}`,
  branch_id: DEMO_BRANCH,
  active: true,
  ...s
}));

const DEMO_SETTINGS: BranchSettings = {
  branch_id: DEMO_BRANCH,
  opening_float: 200,
  open_time: "07:00",
  close_time: "19:00",
  timezone: "Africa/Accra",
  // Cash only, matching how the wash actually runs today. Flip to true here to
  // see the digital payment tiles on the phone.
  momo_enabled: false
};

/**
 * Load the catalogue into local storage. Only the catalogue is replaced —
 * washes and cash counts already logged on this device are left alone, so
 * reopening the demo does not wipe what you were in the middle of testing.
 */
export async function seedDemoData(): Promise<void> {
  await db.transaction("rw", db.attendants, db.services, db.settings, async () => {
    await db.attendants.clear();
    await db.attendants.bulkPut(DEMO_ATTENDANTS);
    await db.services.clear();
    await db.services.bulkPut(DEMO_SERVICES);
    await db.settings.put({ id: "current", ...DEMO_SETTINGS });
  });
}

/** Wipe everything logged in the demo, for a clean run-through. */
export async function resetDemoData(): Promise<void> {
  await db.transaction("rw", db.transactions, db.cashCounts, async () => {
    await db.transactions.clear();
    await db.cashCounts.clear();
  });
}
