/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_DEVICE_EMAIL?: string;
  readonly VITE_DEVICE_PASSWORD?: string;
  readonly VITE_BRANCH_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
