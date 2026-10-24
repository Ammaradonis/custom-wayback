/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * The origin that serves archived pages, when it is not the app's own — e.g.
   * `https://custom-wayback-frame.<account>.workers.dev`. Unset means archived pages
   * are served from the app origin into an opaque-origin sandbox (see ViewerPage).
   */
  readonly VITE_FRAME_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
