interface ImportMetaEnv {
  VITE_API_BASE?: string;
  VITE_AUTH_TOKEN?: string;
}

interface ImportMeta {
  env: ImportMetaEnv;
}
