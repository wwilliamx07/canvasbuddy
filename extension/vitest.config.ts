import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts so the web-extension plugin (manifest, bundling) stays out of tests
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // One environment for everything: PGlite runs under happy-dom, and the extractors, link
    // parser and markdown renderer need its DOMParser / window.
    environment: 'happy-dom',
    environmentOptions: {
      happyDOM: {
        // Parsed Canvas HTML contains iframes, scripts and stylesheets; nothing may be fetched
        settings: {
          disableIframePageLoading: true,
          disableJavaScriptFileLoading: true,
          disableJavaScriptEvaluation: true,
          disableCSSFileLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
          navigation: { disableChildFrameNavigation: true, disableChildPageNavigation: true },
        },
      },
    },
    setupFiles: ['test/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
