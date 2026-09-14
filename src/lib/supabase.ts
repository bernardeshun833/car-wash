import { createClient } from "@supabase/supabase-js";
import { DEMO_MODE } from "./demo";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!DEMO_MODE && (!url || !anonKey)) {
  throw new Error(
    "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set — see .env.example"
  );
}

/**
 * This must point at the car wash's own Supabase project. It is a separate
 * business from the barbershop with a separate database; pointing both apps at
 * one project would silently merge two businesses' takings.
 *
 * In demo mode there is no project, so this is a client pointed at a URL that
 * does not resolve. Nothing calls it — sync.ts returns early before any
 * request — and it exists only so the rest of the app can import `supabase`
 * without every call site having to ask whether a backend exists.
 */
export const supabase = createClient(url ?? "http://demo.invalid", anonKey ?? "demo", {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // The tablet stays signed in as the site device across restarts; the
    // manager should never be asked to type a Supabase password.
    storageKey: "carwash.auth"
  }
});
