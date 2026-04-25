import { copyFileSync } from "fs";
import { builtinModules } from "module";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "copy-obsidian-main",
      writeBundle() {
        copyFileSync("build/main.js", "main.js");
      },
    },
  ],
  build: {
    emptyOutDir: true,
    outDir: "build",
    lib: {
      entry: "src/main.ts",
      formats: ["cjs"],
      fileName: () => "main.js",
    },
    minify: false,
    sourcemap: "inline",
    target: "es2020",
    rollupOptions: {
      external: [
        "obsidian",
        "electron",
        "@codemirror/state",
        "@codemirror/view",
        ...builtinModules,
        ...builtinModules.map((moduleName) => `node:${moduleName}`),
      ],
      output: {
        exports: "default",
      },
    },
  },
});
