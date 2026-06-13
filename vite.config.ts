import { defineConfig } from "vite";

// Tauri expects a fixed port and does not want Vite clearing the screen so we
// can see Rust build output. src-tauri is watched by cargo, not Vite.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
