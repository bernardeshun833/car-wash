import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set — see .env.example"
  );
}

// This must point at the car wash's own Supabase project. It is a separate
// business from the barbershop with a separate database; pointing both apps at
// one project would silently merge two businesses' takings.
export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // The tablet stays signed in as the site device across restarts; the
    // manager should never be asked to type a Supabase password.
    storageKey: "carwash.auth"
  }
});
