"use strict";
const obsidian = require("obsidian");
const view = require("@codemirror/view");
const child_process = require("child_process");
const crypto = require("crypto");
const fs = require("fs/promises");
const net = require("net");
const os = require("os");
const path = require("path");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const crypto__namespace = /* @__PURE__ */ _interopNamespaceDefault(crypto);
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
const net__namespace = /* @__PURE__ */ _interopNamespaceDefault(net);
const os__namespace = /* @__PURE__ */ _interopNamespaceDefault(os);
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const VIEW_TYPE_OXDRAW_MERMAID = "oxdraw-mermaid-editor-view";
const DEFAULT_SETTINGS = {
  oxdrawPath: "oxdraw",
  startingPort: 5151
};
class OxdrawMermaidPlugin extends obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    this.sessions = /* @__PURE__ */ new Map();
  }
  async onload() {
    await this.loadSettings();
    this.registerView(
      VIEW_TYPE_OXDRAW_MERMAID,
      (leaf) => new OxdrawMermaidView(leaf, this)
    );
    this.registerEditorExtension(createMermaidEditorExtension(this));
    this.addSettingTab(new OxdrawMermaidSettingTab(this.app, this));
  }
  async onunload() {
    for (const session of this.sessions.values()) {
      await this.closeSession(session.id);
    }
  }
  getSession(id) {
    return this.sessions.get(id);
  }
  async saveSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      new obsidian.Notice("Oxdraw session not found.");
      return;
    }
    const response = await fetch(`${session.url}/api/diagram/source`, {
      cache: "no-store"
    });
    if (!response.ok) {
      throw new Error(`Unable to read oxdraw source: ${response.status}`);
    }
    const payload = await response.json();
    const cleanBody = stripOxdrawComments(payload.source ?? "");
    await this.replaceOriginalBlock(session, cleanBody);
    new obsidian.Notice("Saved clean Mermaid back to the note.");
  }
  async closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.sessions.delete(sessionId);
    if (!session.process.killed) {
      session.process.kill();
    }
    try {
      await fs__namespace.rm(session.tempDir, { recursive: true, force: true });
    } catch {
    }
  }
  async loadSettings() {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...await this.loadData()
    };
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }
  async openEditorForBlock(file, block) {
    const session = await this.startOxdrawSession(file, block);
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE_OXDRAW_MERMAID,
      active: true,
      state: { sessionId: session.id }
    });
  }
  async startOxdrawSession(file, block) {
    const tempDir = await fs__namespace.mkdtemp(path__namespace.join(os__namespace.tmpdir(), "obsidian-oxdraw-"));
    const tempFile = path__namespace.join(tempDir, "diagram.mmd");
    const logFile = path__namespace.join(tempDir, "oxdraw.log");
    await fs__namespace.writeFile(tempFile, `${block.body.trimEnd()}
`, "utf8");
    const port = await findOpenPort(this.settings.startingPort);
    const args = [
      "--input",
      tempFile,
      "--edit",
      "--serve-host",
      "127.0.0.1",
      "--serve-port",
      String(port)
    ];
    const env = buildOxdrawEnv();
    const child = child_process.spawn(this.settings.oxdrawPath, args, { env });
    const sessionId = crypto__namespace.randomUUID();
    const session = {
      id: sessionId,
      sourcePath: file.path,
      sourceFile: file,
      lineStart: block.startLine,
      lineEnd: block.endLine,
      originalHash: block.hash,
      tempDir,
      tempFile,
      logFile,
      port,
      url: `http://127.0.0.1:${port}`,
      process: child
    };
    let startupError = "";
    await appendLaunchLog(logFile, [
      `time=${(/* @__PURE__ */ new Date()).toISOString()}`,
      `command=${this.settings.oxdrawPath} ${args.join(" ")}`,
      `sourcePath=${file.path}`,
      `tempFile=${tempFile}`,
      `url=${session.url}`,
      `PATH=${env.PATH ?? ""}`,
      ""
    ]);
    child.stderr.on("data", (data) => {
      const text = data.toString();
      startupError += text;
      void appendLaunchLog(logFile, [`[stderr] ${text}`]);
      console.error(`[oxdraw:${sessionId}] ${text}`);
    });
    child.stdout.on("data", (data) => {
      const text = data.toString();
      void appendLaunchLog(logFile, [`[stdout] ${text}`]);
      console.log(`[oxdraw:${sessionId}] ${text}`);
    });
    child.on("error", (error) => {
      startupError += error.message;
      void appendLaunchLog(logFile, [`[process error] ${error.message}`]);
    });
    child.on("exit", (code, signal) => {
      void appendLaunchLog(logFile, [`[exit] code=${code ?? ""} signal=${signal ?? ""}`]);
      this.sessions.delete(sessionId);
    });
    try {
      await waitForOxdraw(session.url, child, () => startupError);
    } catch (error) {
      if (!child.killed) {
        child.kill();
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}. Log: ${logFile}`);
    }
    this.sessions.set(sessionId, session);
    return session;
  }
  async replaceOriginalBlock(session, newBody) {
    await this.app.vault.process(session.sourceFile, (currentSource) => {
      const blocks = parseMermaidBlocks(currentSource);
      const originalAtLocation = blocks.find(
        (block2) => block2.startLine === session.lineStart && block2.endLine === session.lineEnd && block2.hash === session.originalHash
      );
      const originalByHash = blocks.find((block2) => block2.hash === session.originalHash);
      const block = originalAtLocation ?? originalByHash;
      if (!block) {
        throw new Error(
          "The original Mermaid block changed while oxdraw was open. Close this editor and reopen it from the current note."
        );
      }
      const replacement = `${block.openLine}
${newBody.trimEnd()}
${block.closeLine}`;
      return currentSource.replace(block.blockText, replacement);
    });
  }
}
class OxdrawMermaidView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.sessionId = null;
    this.plugin = plugin;
  }
  getViewType() {
    return VIEW_TYPE_OXDRAW_MERMAID;
  }
  getDisplayText() {
    return "Oxdraw Mermaid Editor";
  }
  getIcon() {
    return "pencil-ruler";
  }
  async setState(state, result) {
    await super.setState(state, result);
    this.sessionId = state.sessionId ?? null;
    this.render();
  }
  getState() {
    return {
      sessionId: this.sessionId ?? void 0
    };
  }
  async onOpen() {
    this.render();
  }
  async onClose() {
    if (this.sessionId) {
      await this.plugin.closeSession(this.sessionId);
    }
  }
  render() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("oxdraw-mermaid-view");
    if (!this.sessionId) {
      containerEl.createDiv({
        cls: "oxdraw-mermaid-empty",
        text: "No oxdraw session is attached to this view."
      });
      return;
    }
    const session = this.plugin.getSession(this.sessionId);
    if (!session) {
      containerEl.createDiv({
        cls: "oxdraw-mermaid-empty",
        text: "This oxdraw session has ended."
      });
      return;
    }
    const toolbar = containerEl.createDiv({ cls: "oxdraw-mermaid-toolbar" });
    toolbar.createDiv({
      cls: "oxdraw-mermaid-title",
      text: `${session.sourcePath}:${session.lineStart + 1}`
    });
    const saveButton = toolbar.createEl("button", { text: "Save clean Mermaid" });
    saveButton.addEventListener("click", async () => {
      saveButton.disabled = true;
      try {
        await this.plugin.saveSession(session.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new obsidian.Notice(`Unable to save Mermaid: ${message}`);
        console.error(error);
      } finally {
        saveButton.disabled = false;
      }
    });
    const reloadButton = toolbar.createEl("button", { text: "Reload editor" });
    reloadButton.addEventListener("click", () => {
      iframe.src = session.url;
    });
    const iframe = containerEl.createEl("iframe", {
      cls: "oxdraw-mermaid-frame",
      attr: {
        src: session.url,
        sandbox: "allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts"
      }
    });
  }
}
function createMermaidEditorExtension(plugin) {
  return view.ViewPlugin.fromClass(
    class MermaidEditorButtonPlugin {
      constructor(view2) {
        this.animationFrame = null;
        this.view = view2;
        this.observer = new MutationObserver(() => this.scheduleScan());
        this.observer.observe(view2.dom, { childList: true, subtree: true });
        this.scheduleScan();
      }
      update(update) {
        if (update.docChanged || update.viewportChanged || update.selectionSet || update.geometryChanged) {
          this.scheduleScan();
        }
      }
      destroy() {
        this.observer.disconnect();
        if (this.animationFrame !== null) {
          window.cancelAnimationFrame(this.animationFrame);
        }
        this.removeButtons();
      }
      scheduleScan() {
        if (this.animationFrame !== null) {
          return;
        }
        this.animationFrame = window.requestAnimationFrame(() => {
          this.animationFrame = null;
          this.scan();
        });
      }
      scan() {
        if (!this.view.state.field(obsidian.editorLivePreviewField, false)) {
          this.removeButtons();
          return;
        }
        const mermaidElements = findRenderedMermaidElements(this.view.dom);
        for (const mermaidEl of mermaidElements) {
          const host = pickButtonHost(mermaidEl);
          if (!host || host.querySelector(":scope > .oxdraw-mermaid-edit-button")) {
            continue;
          }
          host.classList.add("oxdraw-mermaid-host");
          const button = host.createEl("button", {
            cls: "oxdraw-mermaid-edit-button",
            attr: {
              "aria-label": "Edit Mermaid block visually",
              title: "Edit in oxdraw",
              type: "button"
            }
          });
          obsidian.setIcon(button, "pencil-ruler");
          button.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            try {
              const info = this.view.state.field(obsidian.editorInfoField);
              const file = info.file;
              if (!(file instanceof obsidian.TFile)) {
                throw new Error("Could not resolve the current Markdown file.");
              }
              const source = this.view.state.doc.toString();
              const block = findMermaidBlockForElement(source, this.view, mermaidEl, host);
              if (!block) {
                throw new Error("Could not locate the source Mermaid block.");
              }
              await plugin.openEditorForBlock(file, block);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              new obsidian.Notice(`Unable to open oxdraw editor: ${message}`);
              console.error(error);
            }
          });
        }
      }
      removeButtons() {
        this.view.dom.querySelectorAll(".oxdraw-mermaid-edit-button").forEach((button) => {
          button.remove();
        });
      }
    }
  );
}
function findMermaidBlockForElement(source, view2, mermaidEl, host) {
  const blocks = parseMermaidBlocks(source);
  if (blocks.length === 0) {
    return null;
  }
  const pos = getElementDocumentPosition(view2, mermaidEl) ?? getElementDocumentPosition(view2, host);
  if (pos !== null) {
    const containing = blocks.find((block) => pos >= block.charStart && pos <= block.charEnd);
    if (containing) {
      return containing;
    }
    return blocks.slice().sort(
      (a, b) => distanceToRange(pos, a.charStart, a.charEnd) - distanceToRange(pos, b.charStart, b.charEnd)
    )[0];
  }
  return blocks[0];
}
function getElementDocumentPosition(view2, element) {
  try {
    return view2.posAtDOM(element);
  } catch {
    return null;
  }
}
function distanceToRange(pos, start, end) {
  if (pos < start) {
    return start - pos;
  }
  if (pos > end) {
    return pos - end;
  }
  return 0;
}
class OxdrawMermaidSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new obsidian.Setting(containerEl).setName("Oxdraw binary path").setDesc("Use 'oxdraw' if it is available on Obsidian's PATH.").addText((text) => {
      text.setPlaceholder("oxdraw").setValue(this.plugin.settings.oxdrawPath).onChange(async (value) => {
        this.plugin.settings.oxdrawPath = value.trim() || "oxdraw";
        await this.plugin.saveSettings();
      });
    });
    new obsidian.Setting(containerEl).setName("Starting port").setDesc("The plugin will choose a random available port from this range.").addText((text) => {
      text.setPlaceholder("5151").setValue(String(this.plugin.settings.startingPort)).onChange(async (value) => {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
          this.plugin.settings.startingPort = parsed;
          await this.plugin.saveSettings();
        }
      });
    });
  }
}
function findRenderedMermaidElements(root) {
  const selectors = [
    ".mermaid",
    ".block-language-mermaid",
    ".language-mermaid",
    "pre:has(code.language-mermaid)",
    "svg[id^='mermaid-']",
    "svg[aria-roledescription]"
  ];
  const seen = /* @__PURE__ */ new Set();
  const results = [];
  for (const selector of selectors) {
    if (root.matches(selector) && !seen.has(root)) {
      seen.add(root);
      results.push(root);
    }
    for (const element of Array.from(root.querySelectorAll(selector))) {
      const htmlElement = element instanceof SVGElement ? element.parentElement : element;
      if (htmlElement instanceof HTMLElement && !seen.has(htmlElement)) {
        seen.add(htmlElement);
        results.push(htmlElement);
      }
    }
  }
  return results;
}
function pickButtonHost(element) {
  const markdownSection = element.closest(".el-pre, .markdown-preview-section > div");
  if (markdownSection instanceof HTMLElement) {
    return markdownSection;
  }
  const codeBlock = element.closest("pre");
  if (codeBlock instanceof HTMLElement) {
    return codeBlock;
  }
  if (element.classList.contains("mermaid") || element.classList.contains("block-language-mermaid")) {
    return element;
  }
  return element.parentElement instanceof HTMLElement ? element.parentElement : element;
}
function parseMermaidBlocks(source) {
  const lines = source.split("\n");
  const lineOffsets = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const openMatch = lines[index].match(/^(\s*)(`{3,}|~{3,})\s*mermaid\b.*$/i);
    if (!openMatch) {
      continue;
    }
    const fence = openMatch[2];
    const fenceChar = fence[0];
    let end = index + 1;
    while (end < lines.length) {
      const closeMatch = lines[end].match(/^(\s*)(`{3,}|~{3,})\s*$/);
      if (closeMatch && closeMatch[2][0] === fenceChar && closeMatch[2].length >= fence.length) {
        const bodyLines = lines.slice(index + 1, end);
        const blockLines = lines.slice(index, end + 1);
        const blockText = blockLines.join("\n");
        blocks.push({
          startLine: index,
          endLine: end,
          charStart: lineOffsets[index],
          charEnd: lineOffsets[end] + lines[end].length,
          openLine: lines[index],
          closeLine: lines[end],
          body: bodyLines.join("\n"),
          blockText,
          hash: hashText(blockText)
        });
        index = end;
        break;
      }
      end += 1;
    }
  }
  return blocks;
}
function stripOxdrawComments(source) {
  const lines = source.split(/\r?\n/);
  const output = [];
  let insideOxdrawBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "%% OXDRAW LAYOUT START") {
      insideOxdrawBlock = true;
      continue;
    }
    if (trimmed === "%% OXDRAW LAYOUT END") {
      insideOxdrawBlock = false;
      continue;
    }
    if (insideOxdrawBlock || trimmed.startsWith("%% OXDRAW IMAGE")) {
      continue;
    }
    output.push(line);
  }
  return output.join("\n").trimEnd();
}
function hashText(text) {
  return crypto__namespace.createHash("sha256").update(text).digest("hex");
}
function buildOxdrawEnv() {
  const existingPath = process.env.PATH ?? "";
  const home = os__namespace.homedir();
  const extraPaths = [
    path__namespace.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ];
  const pathParts = [...extraPaths, existingPath].filter(Boolean);
  return {
    ...process.env,
    PATH: pathParts.join(":")
  };
}
async function findOpenPort(startingPort) {
  const candidateCount = Math.min(100, 65536 - startingPort);
  const startOffset = Math.floor(Math.random() * candidateCount);
  for (let index = 0; index < candidateCount; index += 1) {
    const port = startingPort + (startOffset + index) % candidateCount;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No open port found in range ${startingPort}-${startingPort + candidateCount - 1}.`);
}
async function appendLaunchLog(logFile, lines) {
  try {
    await fs__namespace.appendFile(logFile, `${lines.join("\n")}
`, "utf8");
  } catch (error) {
    console.error(`Unable to write oxdraw launch log '${logFile}'.`, error);
  }
}
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net__namespace.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}
async function waitForOxdraw(baseUrl, child, getStartupError) {
  const deadline = Date.now() + 1e4;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const detail = getStartupError().trim();
      const fallback = child.exitCode === -2 ? "Could not start oxdraw. Set the plugin's Oxdraw binary path to the full executable path." : `oxdraw exited with code ${child.exitCode}`;
      throw new Error(detail || fallback);
    }
    try {
      const response = await fetch(`${baseUrl}/api/diagram/source`, {
        cache: "no-store"
      });
      if (response.ok) {
        return;
      }
    } catch {
    }
    await sleep(150);
  }
  throw new Error("Timed out waiting for oxdraw to start.");
}
function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
module.exports = OxdrawMermaidPlugin;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWFpbi5qcyIsInNvdXJjZXMiOlsiLi4vc3JjL21haW4udHMiXSwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHtcbiAgQXBwLFxuICBlZGl0b3JJbmZvRmllbGQsXG4gIGVkaXRvckxpdmVQcmV2aWV3RmllbGQsXG4gIEl0ZW1WaWV3LFxuICBOb3RpY2UsXG4gIFBsdWdpbixcbiAgUGx1Z2luU2V0dGluZ1RhYixcbiAgU2V0dGluZyxcbiAgVEZpbGUsXG4gIFZpZXdTdGF0ZVJlc3VsdCxcbiAgV29ya3NwYWNlTGVhZixcbiAgc2V0SWNvbixcbn0gZnJvbSBcIm9ic2lkaWFuXCI7XG5pbXBvcnQgeyBFZGl0b3JWaWV3LCBWaWV3UGx1Z2luLCBWaWV3VXBkYXRlIH0gZnJvbSBcIkBjb2RlbWlycm9yL3ZpZXdcIjtcbmltcG9ydCB7IENoaWxkUHJvY2Vzc1dpdGhvdXROdWxsU3RyZWFtcywgc3Bhd24gfSBmcm9tIFwiY2hpbGRfcHJvY2Vzc1wiO1xuaW1wb3J0ICogYXMgY3J5cHRvIGZyb20gXCJjcnlwdG9cIjtcbmltcG9ydCAqIGFzIGZzIGZyb20gXCJmcy9wcm9taXNlc1wiO1xuaW1wb3J0ICogYXMgbmV0IGZyb20gXCJuZXRcIjtcbmltcG9ydCAqIGFzIG9zIGZyb20gXCJvc1wiO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tIFwicGF0aFwiO1xuXG5jb25zdCBWSUVXX1RZUEVfT1hEUkFXX01FUk1BSUQgPSBcIm94ZHJhdy1tZXJtYWlkLWVkaXRvci12aWV3XCI7XG5jb25zdCBERUZBVUxUX1NFVFRJTkdTOiBPeGRyYXdNZXJtYWlkU2V0dGluZ3MgPSB7XG4gIG94ZHJhd1BhdGg6IFwib3hkcmF3XCIsXG4gIHN0YXJ0aW5nUG9ydDogNTE1MSxcbn07XG5cbmludGVyZmFjZSBPeGRyYXdNZXJtYWlkU2V0dGluZ3Mge1xuICBveGRyYXdQYXRoOiBzdHJpbmc7XG4gIHN0YXJ0aW5nUG9ydDogbnVtYmVyO1xufVxuXG5pbnRlcmZhY2UgTWVybWFpZEJsb2NrIHtcbiAgc3RhcnRMaW5lOiBudW1iZXI7XG4gIGVuZExpbmU6IG51bWJlcjtcbiAgY2hhclN0YXJ0OiBudW1iZXI7XG4gIGNoYXJFbmQ6IG51bWJlcjtcbiAgb3BlbkxpbmU6IHN0cmluZztcbiAgY2xvc2VMaW5lOiBzdHJpbmc7XG4gIGJvZHk6IHN0cmluZztcbiAgYmxvY2tUZXh0OiBzdHJpbmc7XG4gIGhhc2g6IHN0cmluZztcbn1cblxuaW50ZXJmYWNlIEVkaXRvclNlc3Npb24ge1xuICBpZDogc3RyaW5nO1xuICBzb3VyY2VQYXRoOiBzdHJpbmc7XG4gIHNvdXJjZUZpbGU6IFRGaWxlO1xuICBsaW5lU3RhcnQ6IG51bWJlcjtcbiAgbGluZUVuZDogbnVtYmVyO1xuICBvcmlnaW5hbEhhc2g6IHN0cmluZztcbiAgdGVtcERpcjogc3RyaW5nO1xuICB0ZW1wRmlsZTogc3RyaW5nO1xuICBsb2dGaWxlOiBzdHJpbmc7XG4gIHBvcnQ6IG51bWJlcjtcbiAgdXJsOiBzdHJpbmc7XG4gIHByb2Nlc3M6IENoaWxkUHJvY2Vzc1dpdGhvdXROdWxsU3RyZWFtcztcbn1cblxuaW50ZXJmYWNlIE94ZHJhd1ZpZXdTdGF0ZSBleHRlbmRzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgc2Vzc2lvbklkPzogc3RyaW5nO1xufVxuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBPeGRyYXdNZXJtYWlkUGx1Z2luIGV4dGVuZHMgUGx1Z2luIHtcbiAgc2V0dGluZ3M6IE94ZHJhd01lcm1haWRTZXR0aW5ncyA9IERFRkFVTFRfU0VUVElOR1M7XG4gIHByaXZhdGUgc2Vzc2lvbnMgPSBuZXcgTWFwPHN0cmluZywgRWRpdG9yU2Vzc2lvbj4oKTtcblxuICBhc3luYyBvbmxvYWQoKSB7XG4gICAgYXdhaXQgdGhpcy5sb2FkU2V0dGluZ3MoKTtcblxuICAgIHRoaXMucmVnaXN0ZXJWaWV3KFxuICAgICAgVklFV19UWVBFX09YRFJBV19NRVJNQUlELFxuICAgICAgKGxlYWYpID0+IG5ldyBPeGRyYXdNZXJtYWlkVmlldyhsZWFmLCB0aGlzKSxcbiAgICApO1xuXG4gICAgdGhpcy5yZWdpc3RlckVkaXRvckV4dGVuc2lvbihjcmVhdGVNZXJtYWlkRWRpdG9yRXh0ZW5zaW9uKHRoaXMpKTtcblxuICAgIHRoaXMuYWRkU2V0dGluZ1RhYihuZXcgT3hkcmF3TWVybWFpZFNldHRpbmdUYWIodGhpcy5hcHAsIHRoaXMpKTtcbiAgfVxuXG4gIGFzeW5jIG9udW5sb2FkKCkge1xuICAgIGZvciAoY29uc3Qgc2Vzc2lvbiBvZiB0aGlzLnNlc3Npb25zLnZhbHVlcygpKSB7XG4gICAgICBhd2FpdCB0aGlzLmNsb3NlU2Vzc2lvbihzZXNzaW9uLmlkKTtcbiAgICB9XG4gIH1cblxuICBnZXRTZXNzaW9uKGlkOiBzdHJpbmcpOiBFZGl0b3JTZXNzaW9uIHwgdW5kZWZpbmVkIHtcbiAgICByZXR1cm4gdGhpcy5zZXNzaW9ucy5nZXQoaWQpO1xuICB9XG5cbiAgYXN5bmMgc2F2ZVNlc3Npb24oc2Vzc2lvbklkOiBzdHJpbmcpIHtcbiAgICBjb25zdCBzZXNzaW9uID0gdGhpcy5zZXNzaW9ucy5nZXQoc2Vzc2lvbklkKTtcbiAgICBpZiAoIXNlc3Npb24pIHtcbiAgICAgIG5ldyBOb3RpY2UoXCJPeGRyYXcgc2Vzc2lvbiBub3QgZm91bmQuXCIpO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZmV0Y2goYCR7c2Vzc2lvbi51cmx9L2FwaS9kaWFncmFtL3NvdXJjZWAsIHtcbiAgICAgIGNhY2hlOiBcIm5vLXN0b3JlXCIsXG4gICAgfSk7XG4gICAgaWYgKCFyZXNwb25zZS5vaykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmFibGUgdG8gcmVhZCBveGRyYXcgc291cmNlOiAke3Jlc3BvbnNlLnN0YXR1c31gKTtcbiAgICB9XG5cbiAgICBjb25zdCBwYXlsb2FkID0gKGF3YWl0IHJlc3BvbnNlLmpzb24oKSkgYXMgeyBzb3VyY2U/OiBzdHJpbmcgfTtcbiAgICBjb25zdCBjbGVhbkJvZHkgPSBzdHJpcE94ZHJhd0NvbW1lbnRzKHBheWxvYWQuc291cmNlID8/IFwiXCIpO1xuICAgIGF3YWl0IHRoaXMucmVwbGFjZU9yaWdpbmFsQmxvY2soc2Vzc2lvbiwgY2xlYW5Cb2R5KTtcbiAgICBuZXcgTm90aWNlKFwiU2F2ZWQgY2xlYW4gTWVybWFpZCBiYWNrIHRvIHRoZSBub3RlLlwiKTtcbiAgfVxuXG4gIGFzeW5jIGNsb3NlU2Vzc2lvbihzZXNzaW9uSWQ6IHN0cmluZykge1xuICAgIGNvbnN0IHNlc3Npb24gPSB0aGlzLnNlc3Npb25zLmdldChzZXNzaW9uSWQpO1xuICAgIGlmICghc2Vzc2lvbikge1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB0aGlzLnNlc3Npb25zLmRlbGV0ZShzZXNzaW9uSWQpO1xuXG4gICAgaWYgKCFzZXNzaW9uLnByb2Nlc3Mua2lsbGVkKSB7XG4gICAgICBzZXNzaW9uLnByb2Nlc3Mua2lsbCgpO1xuICAgIH1cblxuICAgIHRyeSB7XG4gICAgICBhd2FpdCBmcy5ybShzZXNzaW9uLnRlbXBEaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBmb3JjZTogdHJ1ZSB9KTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIC8vIFRlbXAgY2xlYW51cCBmYWlsdXJlIHNob3VsZCBub3QgYmxvY2sgT2JzaWRpYW4gc2h1dGRvd24uXG4gICAgfVxuICB9XG5cbiAgYXN5bmMgbG9hZFNldHRpbmdzKCkge1xuICAgIHRoaXMuc2V0dGluZ3MgPSB7XG4gICAgICAuLi5ERUZBVUxUX1NFVFRJTkdTLFxuICAgICAgLi4uKGF3YWl0IHRoaXMubG9hZERhdGEoKSksXG4gICAgfTtcbiAgfVxuXG4gIGFzeW5jIHNhdmVTZXR0aW5ncygpIHtcbiAgICBhd2FpdCB0aGlzLnNhdmVEYXRhKHRoaXMuc2V0dGluZ3MpO1xuICB9XG5cbiAgYXN5bmMgb3BlbkVkaXRvckZvckJsb2NrKGZpbGU6IFRGaWxlLCBibG9jazogTWVybWFpZEJsb2NrKSB7XG4gICAgY29uc3Qgc2Vzc2lvbiA9IGF3YWl0IHRoaXMuc3RhcnRPeGRyYXdTZXNzaW9uKGZpbGUsIGJsb2NrKTtcbiAgICBjb25zdCBsZWFmID0gdGhpcy5hcHAud29ya3NwYWNlLmdldExlYWYoXCJ0YWJcIik7XG4gICAgYXdhaXQgbGVhZi5zZXRWaWV3U3RhdGUoe1xuICAgICAgdHlwZTogVklFV19UWVBFX09YRFJBV19NRVJNQUlELFxuICAgICAgYWN0aXZlOiB0cnVlLFxuICAgICAgc3RhdGU6IHsgc2Vzc2lvbklkOiBzZXNzaW9uLmlkIH0gc2F0aXNmaWVzIE94ZHJhd1ZpZXdTdGF0ZSxcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgYXN5bmMgc3RhcnRPeGRyYXdTZXNzaW9uKGZpbGU6IFRGaWxlLCBibG9jazogTWVybWFpZEJsb2NrKTogUHJvbWlzZTxFZGl0b3JTZXNzaW9uPiB7XG4gICAgY29uc3QgdGVtcERpciA9IGF3YWl0IGZzLm1rZHRlbXAocGF0aC5qb2luKG9zLnRtcGRpcigpLCBcIm9ic2lkaWFuLW94ZHJhdy1cIikpO1xuICAgIGNvbnN0IHRlbXBGaWxlID0gcGF0aC5qb2luKHRlbXBEaXIsIFwiZGlhZ3JhbS5tbWRcIik7XG4gICAgY29uc3QgbG9nRmlsZSA9IHBhdGguam9pbih0ZW1wRGlyLCBcIm94ZHJhdy5sb2dcIik7XG4gICAgYXdhaXQgZnMud3JpdGVGaWxlKHRlbXBGaWxlLCBgJHtibG9jay5ib2R5LnRyaW1FbmQoKX1cXG5gLCBcInV0ZjhcIik7XG5cbiAgICBjb25zdCBwb3J0ID0gYXdhaXQgZmluZE9wZW5Qb3J0KHRoaXMuc2V0dGluZ3Muc3RhcnRpbmdQb3J0KTtcbiAgICBjb25zdCBhcmdzID0gW1xuICAgICAgXCItLWlucHV0XCIsXG4gICAgICB0ZW1wRmlsZSxcbiAgICAgIFwiLS1lZGl0XCIsXG4gICAgICBcIi0tc2VydmUtaG9zdFwiLFxuICAgICAgXCIxMjcuMC4wLjFcIixcbiAgICAgIFwiLS1zZXJ2ZS1wb3J0XCIsXG4gICAgICBTdHJpbmcocG9ydCksXG4gICAgXTtcblxuICAgIGNvbnN0IGVudiA9IGJ1aWxkT3hkcmF3RW52KCk7XG4gICAgY29uc3QgY2hpbGQgPSBzcGF3bih0aGlzLnNldHRpbmdzLm94ZHJhd1BhdGgsIGFyZ3MsIHsgZW52IH0pO1xuICAgIGNvbnN0IHNlc3Npb25JZCA9IGNyeXB0by5yYW5kb21VVUlEKCk7XG4gICAgY29uc3Qgc2Vzc2lvbjogRWRpdG9yU2Vzc2lvbiA9IHtcbiAgICAgIGlkOiBzZXNzaW9uSWQsXG4gICAgICBzb3VyY2VQYXRoOiBmaWxlLnBhdGgsXG4gICAgICBzb3VyY2VGaWxlOiBmaWxlLFxuICAgICAgbGluZVN0YXJ0OiBibG9jay5zdGFydExpbmUsXG4gICAgICBsaW5lRW5kOiBibG9jay5lbmRMaW5lLFxuICAgICAgb3JpZ2luYWxIYXNoOiBibG9jay5oYXNoLFxuICAgICAgdGVtcERpcixcbiAgICAgIHRlbXBGaWxlLFxuICAgICAgbG9nRmlsZSxcbiAgICAgIHBvcnQsXG4gICAgICB1cmw6IGBodHRwOi8vMTI3LjAuMC4xOiR7cG9ydH1gLFxuICAgICAgcHJvY2VzczogY2hpbGQsXG4gICAgfTtcblxuICAgIGxldCBzdGFydHVwRXJyb3IgPSBcIlwiO1xuICAgIGF3YWl0IGFwcGVuZExhdW5jaExvZyhsb2dGaWxlLCBbXG4gICAgICBgdGltZT0ke25ldyBEYXRlKCkudG9JU09TdHJpbmcoKX1gLFxuICAgICAgYGNvbW1hbmQ9JHt0aGlzLnNldHRpbmdzLm94ZHJhd1BhdGh9ICR7YXJncy5qb2luKFwiIFwiKX1gLFxuICAgICAgYHNvdXJjZVBhdGg9JHtmaWxlLnBhdGh9YCxcbiAgICAgIGB0ZW1wRmlsZT0ke3RlbXBGaWxlfWAsXG4gICAgICBgdXJsPSR7c2Vzc2lvbi51cmx9YCxcbiAgICAgIGBQQVRIPSR7ZW52LlBBVEggPz8gXCJcIn1gLFxuICAgICAgXCJcIixcbiAgICBdKTtcblxuICAgIGNoaWxkLnN0ZGVyci5vbihcImRhdGFcIiwgKGRhdGE6IEJ1ZmZlcikgPT4ge1xuICAgICAgY29uc3QgdGV4dCA9IGRhdGEudG9TdHJpbmcoKTtcbiAgICAgIHN0YXJ0dXBFcnJvciArPSB0ZXh0O1xuICAgICAgdm9pZCBhcHBlbmRMYXVuY2hMb2cobG9nRmlsZSwgW2Bbc3RkZXJyXSAke3RleHR9YF0pO1xuICAgICAgY29uc29sZS5lcnJvcihgW294ZHJhdzoke3Nlc3Npb25JZH1dICR7dGV4dH1gKTtcbiAgICB9KTtcbiAgICBjaGlsZC5zdGRvdXQub24oXCJkYXRhXCIsIChkYXRhOiBCdWZmZXIpID0+IHtcbiAgICAgIGNvbnN0IHRleHQgPSBkYXRhLnRvU3RyaW5nKCk7XG4gICAgICB2b2lkIGFwcGVuZExhdW5jaExvZyhsb2dGaWxlLCBbYFtzdGRvdXRdICR7dGV4dH1gXSk7XG4gICAgICBjb25zb2xlLmxvZyhgW294ZHJhdzoke3Nlc3Npb25JZH1dICR7dGV4dH1gKTtcbiAgICB9KTtcbiAgICBjaGlsZC5vbihcImVycm9yXCIsIChlcnJvcikgPT4ge1xuICAgICAgc3RhcnR1cEVycm9yICs9IGVycm9yLm1lc3NhZ2U7XG4gICAgICB2b2lkIGFwcGVuZExhdW5jaExvZyhsb2dGaWxlLCBbYFtwcm9jZXNzIGVycm9yXSAke2Vycm9yLm1lc3NhZ2V9YF0pO1xuICAgIH0pO1xuICAgIGNoaWxkLm9uKFwiZXhpdFwiLCAoY29kZSwgc2lnbmFsKSA9PiB7XG4gICAgICB2b2lkIGFwcGVuZExhdW5jaExvZyhsb2dGaWxlLCBbYFtleGl0XSBjb2RlPSR7Y29kZSA/PyBcIlwifSBzaWduYWw9JHtzaWduYWwgPz8gXCJcIn1gXSk7XG4gICAgICB0aGlzLnNlc3Npb25zLmRlbGV0ZShzZXNzaW9uSWQpO1xuICAgIH0pO1xuXG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IHdhaXRGb3JPeGRyYXcoc2Vzc2lvbi51cmwsIGNoaWxkLCAoKSA9PiBzdGFydHVwRXJyb3IpO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoIWNoaWxkLmtpbGxlZCkge1xuICAgICAgICBjaGlsZC5raWxsKCk7XG4gICAgICB9XG4gICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGAke21lc3NhZ2V9LiBMb2c6ICR7bG9nRmlsZX1gKTtcbiAgICB9XG5cbiAgICB0aGlzLnNlc3Npb25zLnNldChzZXNzaW9uSWQsIHNlc3Npb24pO1xuICAgIHJldHVybiBzZXNzaW9uO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyByZXBsYWNlT3JpZ2luYWxCbG9jayhzZXNzaW9uOiBFZGl0b3JTZXNzaW9uLCBuZXdCb2R5OiBzdHJpbmcpIHtcbiAgICBhd2FpdCB0aGlzLmFwcC52YXVsdC5wcm9jZXNzKHNlc3Npb24uc291cmNlRmlsZSwgKGN1cnJlbnRTb3VyY2UpID0+IHtcbiAgICAgIGNvbnN0IGJsb2NrcyA9IHBhcnNlTWVybWFpZEJsb2NrcyhjdXJyZW50U291cmNlKTtcbiAgICAgIGNvbnN0IG9yaWdpbmFsQXRMb2NhdGlvbiA9IGJsb2Nrcy5maW5kKFxuICAgICAgICAoYmxvY2spID0+XG4gICAgICAgICAgYmxvY2suc3RhcnRMaW5lID09PSBzZXNzaW9uLmxpbmVTdGFydCAmJlxuICAgICAgICAgIGJsb2NrLmVuZExpbmUgPT09IHNlc3Npb24ubGluZUVuZCAmJlxuICAgICAgICAgIGJsb2NrLmhhc2ggPT09IHNlc3Npb24ub3JpZ2luYWxIYXNoLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IG9yaWdpbmFsQnlIYXNoID0gYmxvY2tzLmZpbmQoKGJsb2NrKSA9PiBibG9jay5oYXNoID09PSBzZXNzaW9uLm9yaWdpbmFsSGFzaCk7XG4gICAgICBjb25zdCBibG9jayA9IG9yaWdpbmFsQXRMb2NhdGlvbiA/PyBvcmlnaW5hbEJ5SGFzaDtcblxuICAgICAgaWYgKCFibG9jaykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgXCJUaGUgb3JpZ2luYWwgTWVybWFpZCBibG9jayBjaGFuZ2VkIHdoaWxlIG94ZHJhdyB3YXMgb3Blbi4gQ2xvc2UgdGhpcyBlZGl0b3IgYW5kIHJlb3BlbiBpdCBmcm9tIHRoZSBjdXJyZW50IG5vdGUuXCIsXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJlcGxhY2VtZW50ID0gYCR7YmxvY2sub3BlbkxpbmV9XFxuJHtuZXdCb2R5LnRyaW1FbmQoKX1cXG4ke2Jsb2NrLmNsb3NlTGluZX1gO1xuICAgICAgcmV0dXJuIGN1cnJlbnRTb3VyY2UucmVwbGFjZShibG9jay5ibG9ja1RleHQsIHJlcGxhY2VtZW50KTtcbiAgICB9KTtcbiAgfVxufVxuXG5jbGFzcyBPeGRyYXdNZXJtYWlkVmlldyBleHRlbmRzIEl0ZW1WaWV3IHtcbiAgcHJpdmF0ZSBwbHVnaW46IE94ZHJhd01lcm1haWRQbHVnaW47XG4gIHByaXZhdGUgc2Vzc2lvbklkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcblxuICBjb25zdHJ1Y3RvcihsZWFmOiBXb3Jrc3BhY2VMZWFmLCBwbHVnaW46IE94ZHJhd01lcm1haWRQbHVnaW4pIHtcbiAgICBzdXBlcihsZWFmKTtcbiAgICB0aGlzLnBsdWdpbiA9IHBsdWdpbjtcbiAgfVxuXG4gIGdldFZpZXdUeXBlKCkge1xuICAgIHJldHVybiBWSUVXX1RZUEVfT1hEUkFXX01FUk1BSUQ7XG4gIH1cblxuICBnZXREaXNwbGF5VGV4dCgpIHtcbiAgICByZXR1cm4gXCJPeGRyYXcgTWVybWFpZCBFZGl0b3JcIjtcbiAgfVxuXG4gIGdldEljb24oKSB7XG4gICAgcmV0dXJuIFwicGVuY2lsLXJ1bGVyXCI7XG4gIH1cblxuICBhc3luYyBzZXRTdGF0ZShzdGF0ZTogT3hkcmF3Vmlld1N0YXRlLCByZXN1bHQ6IFZpZXdTdGF0ZVJlc3VsdCkge1xuICAgIGF3YWl0IHN1cGVyLnNldFN0YXRlKHN0YXRlLCByZXN1bHQpO1xuICAgIHRoaXMuc2Vzc2lvbklkID0gc3RhdGUuc2Vzc2lvbklkID8/IG51bGw7XG4gICAgdGhpcy5yZW5kZXIoKTtcbiAgfVxuXG4gIGdldFN0YXRlKCk6IE94ZHJhd1ZpZXdTdGF0ZSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHNlc3Npb25JZDogdGhpcy5zZXNzaW9uSWQgPz8gdW5kZWZpbmVkLFxuICAgIH07XG4gIH1cblxuICBhc3luYyBvbk9wZW4oKSB7XG4gICAgdGhpcy5yZW5kZXIoKTtcbiAgfVxuXG4gIGFzeW5jIG9uQ2xvc2UoKSB7XG4gICAgaWYgKHRoaXMuc2Vzc2lvbklkKSB7XG4gICAgICBhd2FpdCB0aGlzLnBsdWdpbi5jbG9zZVNlc3Npb24odGhpcy5zZXNzaW9uSWQpO1xuICAgIH1cbiAgfVxuXG4gIHByaXZhdGUgcmVuZGVyKCkge1xuICAgIGNvbnN0IHsgY29udGFpbmVyRWwgfSA9IHRoaXM7XG4gICAgY29udGFpbmVyRWwuZW1wdHkoKTtcbiAgICBjb250YWluZXJFbC5hZGRDbGFzcyhcIm94ZHJhdy1tZXJtYWlkLXZpZXdcIik7XG5cbiAgICBpZiAoIXRoaXMuc2Vzc2lvbklkKSB7XG4gICAgICBjb250YWluZXJFbC5jcmVhdGVEaXYoe1xuICAgICAgICBjbHM6IFwib3hkcmF3LW1lcm1haWQtZW1wdHlcIixcbiAgICAgICAgdGV4dDogXCJObyBveGRyYXcgc2Vzc2lvbiBpcyBhdHRhY2hlZCB0byB0aGlzIHZpZXcuXCIsXG4gICAgICB9KTtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCBzZXNzaW9uID0gdGhpcy5wbHVnaW4uZ2V0U2Vzc2lvbih0aGlzLnNlc3Npb25JZCk7XG4gICAgaWYgKCFzZXNzaW9uKSB7XG4gICAgICBjb250YWluZXJFbC5jcmVhdGVEaXYoe1xuICAgICAgICBjbHM6IFwib3hkcmF3LW1lcm1haWQtZW1wdHlcIixcbiAgICAgICAgdGV4dDogXCJUaGlzIG94ZHJhdyBzZXNzaW9uIGhhcyBlbmRlZC5cIixcbiAgICAgIH0pO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IHRvb2xiYXIgPSBjb250YWluZXJFbC5jcmVhdGVEaXYoeyBjbHM6IFwib3hkcmF3LW1lcm1haWQtdG9vbGJhclwiIH0pO1xuICAgIHRvb2xiYXIuY3JlYXRlRGl2KHtcbiAgICAgIGNsczogXCJveGRyYXctbWVybWFpZC10aXRsZVwiLFxuICAgICAgdGV4dDogYCR7c2Vzc2lvbi5zb3VyY2VQYXRofToke3Nlc3Npb24ubGluZVN0YXJ0ICsgMX1gLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgc2F2ZUJ1dHRvbiA9IHRvb2xiYXIuY3JlYXRlRWwoXCJidXR0b25cIiwgeyB0ZXh0OiBcIlNhdmUgY2xlYW4gTWVybWFpZFwiIH0pO1xuICAgIHNhdmVCdXR0b24uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGFzeW5jICgpID0+IHtcbiAgICAgIHNhdmVCdXR0b24uZGlzYWJsZWQgPSB0cnVlO1xuICAgICAgdHJ5IHtcbiAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNlc3Npb24oc2Vzc2lvbi5pZCk7XG4gICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICBjb25zdCBtZXNzYWdlID0gZXJyb3IgaW5zdGFuY2VvZiBFcnJvciA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpO1xuICAgICAgICBuZXcgTm90aWNlKGBVbmFibGUgdG8gc2F2ZSBNZXJtYWlkOiAke21lc3NhZ2V9YCk7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoZXJyb3IpO1xuICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgc2F2ZUJ1dHRvbi5kaXNhYmxlZCA9IGZhbHNlO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVsb2FkQnV0dG9uID0gdG9vbGJhci5jcmVhdGVFbChcImJ1dHRvblwiLCB7IHRleHQ6IFwiUmVsb2FkIGVkaXRvclwiIH0pO1xuICAgIHJlbG9hZEJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKFwiY2xpY2tcIiwgKCkgPT4ge1xuICAgICAgaWZyYW1lLnNyYyA9IHNlc3Npb24udXJsO1xuICAgIH0pO1xuXG4gICAgY29uc3QgaWZyYW1lID0gY29udGFpbmVyRWwuY3JlYXRlRWwoXCJpZnJhbWVcIiwge1xuICAgICAgY2xzOiBcIm94ZHJhdy1tZXJtYWlkLWZyYW1lXCIsXG4gICAgICBhdHRyOiB7XG4gICAgICAgIHNyYzogc2Vzc2lvbi51cmwsXG4gICAgICAgIHNhbmRib3g6XG4gICAgICAgICAgXCJhbGxvdy1kb3dubG9hZHMgYWxsb3ctZm9ybXMgYWxsb3ctbW9kYWxzIGFsbG93LXBvaW50ZXItbG9jayBhbGxvdy1wb3B1cHMgYWxsb3ctc2FtZS1vcmlnaW4gYWxsb3ctc2NyaXB0c1wiLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjcmVhdGVNZXJtYWlkRWRpdG9yRXh0ZW5zaW9uKHBsdWdpbjogT3hkcmF3TWVybWFpZFBsdWdpbikge1xuICByZXR1cm4gVmlld1BsdWdpbi5mcm9tQ2xhc3MoXG4gICAgY2xhc3MgTWVybWFpZEVkaXRvckJ1dHRvblBsdWdpbiB7XG4gICAgICBwcml2YXRlIHZpZXc6IEVkaXRvclZpZXc7XG4gICAgICBwcml2YXRlIG9ic2VydmVyOiBNdXRhdGlvbk9ic2VydmVyO1xuICAgICAgcHJpdmF0ZSBhbmltYXRpb25GcmFtZTogbnVtYmVyIHwgbnVsbCA9IG51bGw7XG5cbiAgICAgIGNvbnN0cnVjdG9yKHZpZXc6IEVkaXRvclZpZXcpIHtcbiAgICAgICAgdGhpcy52aWV3ID0gdmlldztcbiAgICAgICAgdGhpcy5vYnNlcnZlciA9IG5ldyBNdXRhdGlvbk9ic2VydmVyKCgpID0+IHRoaXMuc2NoZWR1bGVTY2FuKCkpO1xuICAgICAgICB0aGlzLm9ic2VydmVyLm9ic2VydmUodmlldy5kb20sIHsgY2hpbGRMaXN0OiB0cnVlLCBzdWJ0cmVlOiB0cnVlIH0pO1xuICAgICAgICB0aGlzLnNjaGVkdWxlU2NhbigpO1xuICAgICAgfVxuXG4gICAgICB1cGRhdGUodXBkYXRlOiBWaWV3VXBkYXRlKSB7XG4gICAgICAgIGlmIChcbiAgICAgICAgICB1cGRhdGUuZG9jQ2hhbmdlZCB8fFxuICAgICAgICAgIHVwZGF0ZS52aWV3cG9ydENoYW5nZWQgfHxcbiAgICAgICAgICB1cGRhdGUuc2VsZWN0aW9uU2V0IHx8XG4gICAgICAgICAgdXBkYXRlLmdlb21ldHJ5Q2hhbmdlZFxuICAgICAgICApIHtcbiAgICAgICAgICB0aGlzLnNjaGVkdWxlU2NhbigpO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIGRlc3Ryb3koKSB7XG4gICAgICAgIHRoaXMub2JzZXJ2ZXIuZGlzY29ubmVjdCgpO1xuICAgICAgICBpZiAodGhpcy5hbmltYXRpb25GcmFtZSAhPT0gbnVsbCkge1xuICAgICAgICAgIHdpbmRvdy5jYW5jZWxBbmltYXRpb25GcmFtZSh0aGlzLmFuaW1hdGlvbkZyYW1lKTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLnJlbW92ZUJ1dHRvbnMoKTtcbiAgICAgIH1cblxuICAgICAgcHJpdmF0ZSBzY2hlZHVsZVNjYW4oKSB7XG4gICAgICAgIGlmICh0aGlzLmFuaW1hdGlvbkZyYW1lICE9PSBudWxsKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuYW5pbWF0aW9uRnJhbWUgPSB3aW5kb3cucmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpID0+IHtcbiAgICAgICAgICB0aGlzLmFuaW1hdGlvbkZyYW1lID0gbnVsbDtcbiAgICAgICAgICB0aGlzLnNjYW4oKTtcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIHByaXZhdGUgc2NhbigpIHtcbiAgICAgICAgaWYgKCF0aGlzLnZpZXcuc3RhdGUuZmllbGQoZWRpdG9yTGl2ZVByZXZpZXdGaWVsZCwgZmFsc2UpKSB7XG4gICAgICAgICAgdGhpcy5yZW1vdmVCdXR0b25zKCk7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgbWVybWFpZEVsZW1lbnRzID0gZmluZFJlbmRlcmVkTWVybWFpZEVsZW1lbnRzKHRoaXMudmlldy5kb20pO1xuICAgICAgICBmb3IgKGNvbnN0IG1lcm1haWRFbCBvZiBtZXJtYWlkRWxlbWVudHMpIHtcbiAgICAgICAgICBjb25zdCBob3N0ID0gcGlja0J1dHRvbkhvc3QobWVybWFpZEVsKTtcbiAgICAgICAgICBpZiAoIWhvc3QgfHwgaG9zdC5xdWVyeVNlbGVjdG9yKFwiOnNjb3BlID4gLm94ZHJhdy1tZXJtYWlkLWVkaXQtYnV0dG9uXCIpKSB7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBob3N0LmNsYXNzTGlzdC5hZGQoXCJveGRyYXctbWVybWFpZC1ob3N0XCIpO1xuICAgICAgICAgIGNvbnN0IGJ1dHRvbiA9IGhvc3QuY3JlYXRlRWwoXCJidXR0b25cIiwge1xuICAgICAgICAgICAgY2xzOiBcIm94ZHJhdy1tZXJtYWlkLWVkaXQtYnV0dG9uXCIsXG4gICAgICAgICAgICBhdHRyOiB7XG4gICAgICAgICAgICAgIFwiYXJpYS1sYWJlbFwiOiBcIkVkaXQgTWVybWFpZCBibG9jayB2aXN1YWxseVwiLFxuICAgICAgICAgICAgICB0aXRsZTogXCJFZGl0IGluIG94ZHJhd1wiLFxuICAgICAgICAgICAgICB0eXBlOiBcImJ1dHRvblwiLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9KTtcbiAgICAgICAgICBzZXRJY29uKGJ1dHRvbiwgXCJwZW5jaWwtcnVsZXJcIik7XG5cbiAgICAgICAgICBidXR0b24uYWRkRXZlbnRMaXN0ZW5lcihcImNsaWNrXCIsIGFzeW5jIChldmVudCkgPT4ge1xuICAgICAgICAgICAgZXZlbnQucHJldmVudERlZmF1bHQoKTtcbiAgICAgICAgICAgIGV2ZW50LnN0b3BQcm9wYWdhdGlvbigpO1xuXG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICBjb25zdCBpbmZvID0gdGhpcy52aWV3LnN0YXRlLmZpZWxkKGVkaXRvckluZm9GaWVsZCk7XG4gICAgICAgICAgICAgIGNvbnN0IGZpbGUgPSBpbmZvLmZpbGU7XG4gICAgICAgICAgICAgIGlmICghKGZpbGUgaW5zdGFuY2VvZiBURmlsZSkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJDb3VsZCBub3QgcmVzb2x2ZSB0aGUgY3VycmVudCBNYXJrZG93biBmaWxlLlwiKTtcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIGNvbnN0IHNvdXJjZSA9IHRoaXMudmlldy5zdGF0ZS5kb2MudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgY29uc3QgYmxvY2sgPSBmaW5kTWVybWFpZEJsb2NrRm9yRWxlbWVudChzb3VyY2UsIHRoaXMudmlldywgbWVybWFpZEVsLCBob3N0KTtcbiAgICAgICAgICAgICAgaWYgKCFibG9jaykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcIkNvdWxkIG5vdCBsb2NhdGUgdGhlIHNvdXJjZSBNZXJtYWlkIGJsb2NrLlwiKTtcbiAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgIGF3YWl0IHBsdWdpbi5vcGVuRWRpdG9yRm9yQmxvY2soZmlsZSwgYmxvY2spO1xuICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgY29uc3QgbWVzc2FnZSA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICAgICAgICAgICAgbmV3IE5vdGljZShgVW5hYmxlIHRvIG9wZW4gb3hkcmF3IGVkaXRvcjogJHttZXNzYWdlfWApO1xuICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKGVycm9yKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICBwcml2YXRlIHJlbW92ZUJ1dHRvbnMoKSB7XG4gICAgICAgIHRoaXMudmlldy5kb20ucXVlcnlTZWxlY3RvckFsbChcIi5veGRyYXctbWVybWFpZC1lZGl0LWJ1dHRvblwiKS5mb3JFYWNoKChidXR0b24pID0+IHtcbiAgICAgICAgICBidXR0b24ucmVtb3ZlKCk7XG4gICAgICAgIH0pO1xuICAgICAgfVxuICAgIH0sXG4gICk7XG59XG5cbmZ1bmN0aW9uIGZpbmRNZXJtYWlkQmxvY2tGb3JFbGVtZW50KFxuICBzb3VyY2U6IHN0cmluZyxcbiAgdmlldzogRWRpdG9yVmlldyxcbiAgbWVybWFpZEVsOiBIVE1MRWxlbWVudCxcbiAgaG9zdDogSFRNTEVsZW1lbnQsXG4pOiBNZXJtYWlkQmxvY2sgfCBudWxsIHtcbiAgY29uc3QgYmxvY2tzID0gcGFyc2VNZXJtYWlkQmxvY2tzKHNvdXJjZSk7XG4gIGlmIChibG9ja3MubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICBjb25zdCBwb3MgPSBnZXRFbGVtZW50RG9jdW1lbnRQb3NpdGlvbih2aWV3LCBtZXJtYWlkRWwpID8/IGdldEVsZW1lbnREb2N1bWVudFBvc2l0aW9uKHZpZXcsIGhvc3QpO1xuICBpZiAocG9zICE9PSBudWxsKSB7XG4gICAgY29uc3QgY29udGFpbmluZyA9IGJsb2Nrcy5maW5kKChibG9jaykgPT4gcG9zID49IGJsb2NrLmNoYXJTdGFydCAmJiBwb3MgPD0gYmxvY2suY2hhckVuZCk7XG4gICAgaWYgKGNvbnRhaW5pbmcpIHtcbiAgICAgIHJldHVybiBjb250YWluaW5nO1xuICAgIH1cblxuICAgIHJldHVybiBibG9ja3NcbiAgICAgIC5zbGljZSgpXG4gICAgICAuc29ydChcbiAgICAgICAgKGEsIGIpID0+XG4gICAgICAgICAgZGlzdGFuY2VUb1JhbmdlKHBvcywgYS5jaGFyU3RhcnQsIGEuY2hhckVuZCkgLVxuICAgICAgICAgIGRpc3RhbmNlVG9SYW5nZShwb3MsIGIuY2hhclN0YXJ0LCBiLmNoYXJFbmQpLFxuICAgICAgKVswXTtcbiAgfVxuXG4gIHJldHVybiBibG9ja3NbMF07XG59XG5cbmZ1bmN0aW9uIGdldEVsZW1lbnREb2N1bWVudFBvc2l0aW9uKHZpZXc6IEVkaXRvclZpZXcsIGVsZW1lbnQ6IEhUTUxFbGVtZW50KTogbnVtYmVyIHwgbnVsbCB7XG4gIHRyeSB7XG4gICAgcmV0dXJuIHZpZXcucG9zQXRET00oZWxlbWVudCk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbmZ1bmN0aW9uIGRpc3RhbmNlVG9SYW5nZShwb3M6IG51bWJlciwgc3RhcnQ6IG51bWJlciwgZW5kOiBudW1iZXIpOiBudW1iZXIge1xuICBpZiAocG9zIDwgc3RhcnQpIHtcbiAgICByZXR1cm4gc3RhcnQgLSBwb3M7XG4gIH1cbiAgaWYgKHBvcyA+IGVuZCkge1xuICAgIHJldHVybiBwb3MgLSBlbmQ7XG4gIH1cbiAgcmV0dXJuIDA7XG59XG5cbmNsYXNzIE94ZHJhd01lcm1haWRTZXR0aW5nVGFiIGV4dGVuZHMgUGx1Z2luU2V0dGluZ1RhYiB7XG4gIHByaXZhdGUgcGx1Z2luOiBPeGRyYXdNZXJtYWlkUGx1Z2luO1xuXG4gIGNvbnN0cnVjdG9yKGFwcDogQXBwLCBwbHVnaW46IE94ZHJhd01lcm1haWRQbHVnaW4pIHtcbiAgICBzdXBlcihhcHAsIHBsdWdpbik7XG4gICAgdGhpcy5wbHVnaW4gPSBwbHVnaW47XG4gIH1cblxuICBkaXNwbGF5KCkge1xuICAgIGNvbnN0IHsgY29udGFpbmVyRWwgfSA9IHRoaXM7XG4gICAgY29udGFpbmVyRWwuZW1wdHkoKTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJPeGRyYXcgYmluYXJ5IHBhdGhcIilcbiAgICAgIC5zZXREZXNjKFwiVXNlICdveGRyYXcnIGlmIGl0IGlzIGF2YWlsYWJsZSBvbiBPYnNpZGlhbidzIFBBVEguXCIpXG4gICAgICAuYWRkVGV4dCgodGV4dCkgPT4ge1xuICAgICAgICB0ZXh0XG4gICAgICAgICAgLnNldFBsYWNlaG9sZGVyKFwib3hkcmF3XCIpXG4gICAgICAgICAgLnNldFZhbHVlKHRoaXMucGx1Z2luLnNldHRpbmdzLm94ZHJhd1BhdGgpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgdGhpcy5wbHVnaW4uc2V0dGluZ3Mub3hkcmF3UGF0aCA9IHZhbHVlLnRyaW0oKSB8fCBcIm94ZHJhd1wiO1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5wbHVnaW4uc2F2ZVNldHRpbmdzKCk7XG4gICAgICAgICAgfSk7XG4gICAgICB9KTtcblxuICAgIG5ldyBTZXR0aW5nKGNvbnRhaW5lckVsKVxuICAgICAgLnNldE5hbWUoXCJTdGFydGluZyBwb3J0XCIpXG4gICAgICAuc2V0RGVzYyhcIlRoZSBwbHVnaW4gd2lsbCBjaG9vc2UgYSByYW5kb20gYXZhaWxhYmxlIHBvcnQgZnJvbSB0aGlzIHJhbmdlLlwiKVxuICAgICAgLmFkZFRleHQoKHRleHQpID0+IHtcbiAgICAgICAgdGV4dFxuICAgICAgICAgIC5zZXRQbGFjZWhvbGRlcihcIjUxNTFcIilcbiAgICAgICAgICAuc2V0VmFsdWUoU3RyaW5nKHRoaXMucGx1Z2luLnNldHRpbmdzLnN0YXJ0aW5nUG9ydCkpXG4gICAgICAgICAgLm9uQ2hhbmdlKGFzeW5jICh2YWx1ZSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgcGFyc2VkID0gTnVtYmVyLnBhcnNlSW50KHZhbHVlLCAxMCk7XG4gICAgICAgICAgICBpZiAoTnVtYmVyLmlzRmluaXRlKHBhcnNlZCkgJiYgcGFyc2VkID4gMCAmJiBwYXJzZWQgPCA2NTUzNikge1xuICAgICAgICAgICAgICB0aGlzLnBsdWdpbi5zZXR0aW5ncy5zdGFydGluZ1BvcnQgPSBwYXJzZWQ7XG4gICAgICAgICAgICAgIGF3YWl0IHRoaXMucGx1Z2luLnNhdmVTZXR0aW5ncygpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuICAgICAgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gZmluZFJlbmRlcmVkTWVybWFpZEVsZW1lbnRzKHJvb3Q6IEhUTUxFbGVtZW50KTogSFRNTEVsZW1lbnRbXSB7XG4gIGNvbnN0IHNlbGVjdG9ycyA9IFtcbiAgICBcIi5tZXJtYWlkXCIsXG4gICAgXCIuYmxvY2stbGFuZ3VhZ2UtbWVybWFpZFwiLFxuICAgIFwiLmxhbmd1YWdlLW1lcm1haWRcIixcbiAgICBcInByZTpoYXMoY29kZS5sYW5ndWFnZS1tZXJtYWlkKVwiLFxuICAgIFwic3ZnW2lkXj0nbWVybWFpZC0nXVwiLFxuICAgIFwic3ZnW2FyaWEtcm9sZWRlc2NyaXB0aW9uXVwiLFxuICBdO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxIVE1MRWxlbWVudD4oKTtcbiAgY29uc3QgcmVzdWx0czogSFRNTEVsZW1lbnRbXSA9IFtdO1xuXG4gIGZvciAoY29uc3Qgc2VsZWN0b3Igb2Ygc2VsZWN0b3JzKSB7XG4gICAgaWYgKHJvb3QubWF0Y2hlcyhzZWxlY3RvcikgJiYgIXNlZW4uaGFzKHJvb3QpKSB7XG4gICAgICBzZWVuLmFkZChyb290KTtcbiAgICAgIHJlc3VsdHMucHVzaChyb290KTtcbiAgICB9XG5cbiAgICBmb3IgKGNvbnN0IGVsZW1lbnQgb2YgQXJyYXkuZnJvbShyb290LnF1ZXJ5U2VsZWN0b3JBbGwoc2VsZWN0b3IpKSkge1xuICAgICAgY29uc3QgaHRtbEVsZW1lbnQgPSBlbGVtZW50IGluc3RhbmNlb2YgU1ZHRWxlbWVudCA/IGVsZW1lbnQucGFyZW50RWxlbWVudCA6IGVsZW1lbnQ7XG4gICAgICBpZiAoaHRtbEVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MRWxlbWVudCAmJiAhc2Vlbi5oYXMoaHRtbEVsZW1lbnQpKSB7XG4gICAgICAgIHNlZW4uYWRkKGh0bWxFbGVtZW50KTtcbiAgICAgICAgcmVzdWx0cy5wdXNoKGh0bWxFbGVtZW50KTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gcmVzdWx0cztcbn1cblxuZnVuY3Rpb24gcGlja0J1dHRvbkhvc3QoZWxlbWVudDogSFRNTEVsZW1lbnQpOiBIVE1MRWxlbWVudCB8IG51bGwge1xuICBjb25zdCBtYXJrZG93blNlY3Rpb24gPSBlbGVtZW50LmNsb3Nlc3QoXCIuZWwtcHJlLCAubWFya2Rvd24tcHJldmlldy1zZWN0aW9uID4gZGl2XCIpO1xuICBpZiAobWFya2Rvd25TZWN0aW9uIGluc3RhbmNlb2YgSFRNTEVsZW1lbnQpIHtcbiAgICByZXR1cm4gbWFya2Rvd25TZWN0aW9uO1xuICB9XG5cbiAgY29uc3QgY29kZUJsb2NrID0gZWxlbWVudC5jbG9zZXN0KFwicHJlXCIpO1xuICBpZiAoY29kZUJsb2NrIGluc3RhbmNlb2YgSFRNTEVsZW1lbnQpIHtcbiAgICByZXR1cm4gY29kZUJsb2NrO1xuICB9XG5cbiAgaWYgKFxuICAgIGVsZW1lbnQuY2xhc3NMaXN0LmNvbnRhaW5zKFwibWVybWFpZFwiKSB8fFxuICAgIGVsZW1lbnQuY2xhc3NMaXN0LmNvbnRhaW5zKFwiYmxvY2stbGFuZ3VhZ2UtbWVybWFpZFwiKVxuICApIHtcbiAgICByZXR1cm4gZWxlbWVudDtcbiAgfVxuXG4gIHJldHVybiBlbGVtZW50LnBhcmVudEVsZW1lbnQgaW5zdGFuY2VvZiBIVE1MRWxlbWVudCA/IGVsZW1lbnQucGFyZW50RWxlbWVudCA6IGVsZW1lbnQ7XG59XG5cbmZ1bmN0aW9uIHBhcnNlTWVybWFpZEJsb2Nrcyhzb3VyY2U6IHN0cmluZyk6IE1lcm1haWRCbG9ja1tdIHtcbiAgY29uc3QgbGluZXMgPSBzb3VyY2Uuc3BsaXQoXCJcXG5cIik7XG4gIGNvbnN0IGxpbmVPZmZzZXRzOiBudW1iZXJbXSA9IFtdO1xuICBsZXQgb2Zmc2V0ID0gMDtcbiAgZm9yIChjb25zdCBsaW5lIG9mIGxpbmVzKSB7XG4gICAgbGluZU9mZnNldHMucHVzaChvZmZzZXQpO1xuICAgIG9mZnNldCArPSBsaW5lLmxlbmd0aCArIDE7XG4gIH1cblxuICBjb25zdCBibG9ja3M6IE1lcm1haWRCbG9ja1tdID0gW107XG5cbiAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IGxpbmVzLmxlbmd0aDsgaW5kZXggKz0gMSkge1xuICAgIGNvbnN0IG9wZW5NYXRjaCA9IGxpbmVzW2luZGV4XS5tYXRjaCgvXihcXHMqKShgezMsfXx+ezMsfSlcXHMqbWVybWFpZFxcYi4qJC9pKTtcbiAgICBpZiAoIW9wZW5NYXRjaCkge1xuICAgICAgY29udGludWU7XG4gICAgfVxuXG4gICAgY29uc3QgZmVuY2UgPSBvcGVuTWF0Y2hbMl07XG4gICAgY29uc3QgZmVuY2VDaGFyID0gZmVuY2VbMF07XG4gICAgbGV0IGVuZCA9IGluZGV4ICsgMTtcbiAgICB3aGlsZSAoZW5kIDwgbGluZXMubGVuZ3RoKSB7XG4gICAgICBjb25zdCBjbG9zZU1hdGNoID0gbGluZXNbZW5kXS5tYXRjaCgvXihcXHMqKShgezMsfXx+ezMsfSlcXHMqJC8pO1xuICAgICAgaWYgKGNsb3NlTWF0Y2ggJiYgY2xvc2VNYXRjaFsyXVswXSA9PT0gZmVuY2VDaGFyICYmIGNsb3NlTWF0Y2hbMl0ubGVuZ3RoID49IGZlbmNlLmxlbmd0aCkge1xuICAgICAgICBjb25zdCBib2R5TGluZXMgPSBsaW5lcy5zbGljZShpbmRleCArIDEsIGVuZCk7XG4gICAgICAgIGNvbnN0IGJsb2NrTGluZXMgPSBsaW5lcy5zbGljZShpbmRleCwgZW5kICsgMSk7XG4gICAgICAgIGNvbnN0IGJsb2NrVGV4dCA9IGJsb2NrTGluZXMuam9pbihcIlxcblwiKTtcbiAgICAgICAgYmxvY2tzLnB1c2goe1xuICAgICAgICAgIHN0YXJ0TGluZTogaW5kZXgsXG4gICAgICAgICAgZW5kTGluZTogZW5kLFxuICAgICAgICAgIGNoYXJTdGFydDogbGluZU9mZnNldHNbaW5kZXhdLFxuICAgICAgICAgIGNoYXJFbmQ6IGxpbmVPZmZzZXRzW2VuZF0gKyBsaW5lc1tlbmRdLmxlbmd0aCxcbiAgICAgICAgICBvcGVuTGluZTogbGluZXNbaW5kZXhdLFxuICAgICAgICAgIGNsb3NlTGluZTogbGluZXNbZW5kXSxcbiAgICAgICAgICBib2R5OiBib2R5TGluZXMuam9pbihcIlxcblwiKSxcbiAgICAgICAgICBibG9ja1RleHQsXG4gICAgICAgICAgaGFzaDogaGFzaFRleHQoYmxvY2tUZXh0KSxcbiAgICAgICAgfSk7XG4gICAgICAgIGluZGV4ID0gZW5kO1xuICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICAgIGVuZCArPSAxO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBibG9ja3M7XG59XG5cbmZ1bmN0aW9uIHN0cmlwT3hkcmF3Q29tbWVudHMoc291cmNlOiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBsaW5lcyA9IHNvdXJjZS5zcGxpdCgvXFxyP1xcbi8pO1xuICBjb25zdCBvdXRwdXQ6IHN0cmluZ1tdID0gW107XG4gIGxldCBpbnNpZGVPeGRyYXdCbG9jayA9IGZhbHNlO1xuXG4gIGZvciAoY29uc3QgbGluZSBvZiBsaW5lcykge1xuICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKTtcbiAgICBpZiAodHJpbW1lZCA9PT0gXCIlJSBPWERSQVcgTEFZT1VUIFNUQVJUXCIpIHtcbiAgICAgIGluc2lkZU94ZHJhd0Jsb2NrID0gdHJ1ZTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAodHJpbW1lZCA9PT0gXCIlJSBPWERSQVcgTEFZT1VUIEVORFwiKSB7XG4gICAgICBpbnNpZGVPeGRyYXdCbG9jayA9IGZhbHNlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmIChpbnNpZGVPeGRyYXdCbG9jayB8fCB0cmltbWVkLnN0YXJ0c1dpdGgoXCIlJSBPWERSQVcgSU1BR0VcIikpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBvdXRwdXQucHVzaChsaW5lKTtcbiAgfVxuXG4gIHJldHVybiBvdXRwdXQuam9pbihcIlxcblwiKS50cmltRW5kKCk7XG59XG5cbmZ1bmN0aW9uIGhhc2hUZXh0KHRleHQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBjcnlwdG8uY3JlYXRlSGFzaChcInNoYTI1NlwiKS51cGRhdGUodGV4dCkuZGlnZXN0KFwiaGV4XCIpO1xufVxuXG5mdW5jdGlvbiBidWlsZE94ZHJhd0VudigpOiBOb2RlSlMuUHJvY2Vzc0VudiB7XG4gIGNvbnN0IGV4aXN0aW5nUGF0aCA9IHByb2Nlc3MuZW52LlBBVEggPz8gXCJcIjtcbiAgY29uc3QgaG9tZSA9IG9zLmhvbWVkaXIoKTtcbiAgY29uc3QgZXh0cmFQYXRocyA9IFtcbiAgICBwYXRoLmpvaW4oaG9tZSwgXCIuY2FyZ29cIiwgXCJiaW5cIiksXG4gICAgXCIvb3B0L2hvbWVicmV3L2JpblwiLFxuICAgIFwiL3Vzci9sb2NhbC9iaW5cIixcbiAgXTtcbiAgY29uc3QgcGF0aFBhcnRzID0gWy4uLmV4dHJhUGF0aHMsIGV4aXN0aW5nUGF0aF0uZmlsdGVyKEJvb2xlYW4pO1xuXG4gIHJldHVybiB7XG4gICAgLi4ucHJvY2Vzcy5lbnYsXG4gICAgUEFUSDogcGF0aFBhcnRzLmpvaW4oXCI6XCIpLFxuICB9O1xufVxuXG5hc3luYyBmdW5jdGlvbiBmaW5kT3BlblBvcnQoc3RhcnRpbmdQb3J0OiBudW1iZXIpOiBQcm9taXNlPG51bWJlcj4ge1xuICBjb25zdCBjYW5kaWRhdGVDb3VudCA9IE1hdGgubWluKDEwMCwgNjU1MzYgLSBzdGFydGluZ1BvcnQpO1xuICBjb25zdCBzdGFydE9mZnNldCA9IE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIGNhbmRpZGF0ZUNvdW50KTtcblxuICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgY2FuZGlkYXRlQ291bnQ7IGluZGV4ICs9IDEpIHtcbiAgICBjb25zdCBwb3J0ID0gc3RhcnRpbmdQb3J0ICsgKChzdGFydE9mZnNldCArIGluZGV4KSAlIGNhbmRpZGF0ZUNvdW50KTtcbiAgICBpZiAoYXdhaXQgaXNQb3J0QXZhaWxhYmxlKHBvcnQpKSB7XG4gICAgICByZXR1cm4gcG9ydDtcbiAgICB9XG4gIH1cbiAgdGhyb3cgbmV3IEVycm9yKGBObyBvcGVuIHBvcnQgZm91bmQgaW4gcmFuZ2UgJHtzdGFydGluZ1BvcnR9LSR7c3RhcnRpbmdQb3J0ICsgY2FuZGlkYXRlQ291bnQgLSAxfS5gKTtcbn1cblxuYXN5bmMgZnVuY3Rpb24gYXBwZW5kTGF1bmNoTG9nKGxvZ0ZpbGU6IHN0cmluZywgbGluZXM6IHN0cmluZ1tdKSB7XG4gIHRyeSB7XG4gICAgYXdhaXQgZnMuYXBwZW5kRmlsZShsb2dGaWxlLCBgJHtsaW5lcy5qb2luKFwiXFxuXCIpfVxcbmAsIFwidXRmOFwiKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKGBVbmFibGUgdG8gd3JpdGUgb3hkcmF3IGxhdW5jaCBsb2cgJyR7bG9nRmlsZX0nLmAsIGVycm9yKTtcbiAgfVxufVxuXG5mdW5jdGlvbiBpc1BvcnRBdmFpbGFibGUocG9ydDogbnVtYmVyKTogUHJvbWlzZTxib29sZWFuPiB7XG4gIHJldHVybiBuZXcgUHJvbWlzZSgocmVzb2x2ZSkgPT4ge1xuICAgIGNvbnN0IHNlcnZlciA9IG5ldC5jcmVhdGVTZXJ2ZXIoKTtcbiAgICBzZXJ2ZXIub25jZShcImVycm9yXCIsICgpID0+IHJlc29sdmUoZmFsc2UpKTtcbiAgICBzZXJ2ZXIub25jZShcImxpc3RlbmluZ1wiLCAoKSA9PiB7XG4gICAgICBzZXJ2ZXIuY2xvc2UoKCkgPT4gcmVzb2x2ZSh0cnVlKSk7XG4gICAgfSk7XG4gICAgc2VydmVyLmxpc3Rlbihwb3J0LCBcIjEyNy4wLjAuMVwiKTtcbiAgfSk7XG59XG5cbmFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JPeGRyYXcoXG4gIGJhc2VVcmw6IHN0cmluZyxcbiAgY2hpbGQ6IENoaWxkUHJvY2Vzc1dpdGhvdXROdWxsU3RyZWFtcyxcbiAgZ2V0U3RhcnR1cEVycm9yOiAoKSA9PiBzdHJpbmcsXG4pIHtcbiAgY29uc3QgZGVhZGxpbmUgPSBEYXRlLm5vdygpICsgMTBfMDAwO1xuICB3aGlsZSAoRGF0ZS5ub3coKSA8IGRlYWRsaW5lKSB7XG4gICAgaWYgKGNoaWxkLmV4aXRDb2RlICE9PSBudWxsKSB7XG4gICAgICBjb25zdCBkZXRhaWwgPSBnZXRTdGFydHVwRXJyb3IoKS50cmltKCk7XG4gICAgICBjb25zdCBmYWxsYmFjayA9XG4gICAgICAgIGNoaWxkLmV4aXRDb2RlID09PSAtMlxuICAgICAgICAgID8gXCJDb3VsZCBub3Qgc3RhcnQgb3hkcmF3LiBTZXQgdGhlIHBsdWdpbidzIE94ZHJhdyBiaW5hcnkgcGF0aCB0byB0aGUgZnVsbCBleGVjdXRhYmxlIHBhdGguXCJcbiAgICAgICAgICA6IGBveGRyYXcgZXhpdGVkIHdpdGggY29kZSAke2NoaWxkLmV4aXRDb2RlfWA7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoZGV0YWlsIHx8IGZhbGxiYWNrKTtcbiAgICB9XG5cbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaChgJHtiYXNlVXJsfS9hcGkvZGlhZ3JhbS9zb3VyY2VgLCB7XG4gICAgICAgIGNhY2hlOiBcIm5vLXN0b3JlXCIsXG4gICAgICB9KTtcbiAgICAgIGlmIChyZXNwb25zZS5vaykge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBTZXJ2ZXIgaXMgbm90IHJlYWR5IHlldC5cbiAgICB9XG5cbiAgICBhd2FpdCBzbGVlcCgxNTApO1xuICB9XG5cbiAgdGhyb3cgbmV3IEVycm9yKFwiVGltZWQgb3V0IHdhaXRpbmcgZm9yIG94ZHJhdyB0byBzdGFydC5cIik7XG59XG5cbmZ1bmN0aW9uIHNsZWVwKG1zOiBudW1iZXIpOiBQcm9taXNlPHZvaWQ+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB3aW5kb3cuc2V0VGltZW91dChyZXNvbHZlLCBtcykpO1xufVxuIl0sIm5hbWVzIjpbIlBsdWdpbiIsIk5vdGljZSIsImZzIiwicGF0aCIsIm9zIiwic3Bhd24iLCJjcnlwdG8iLCJibG9jayIsIkl0ZW1WaWV3IiwiVmlld1BsdWdpbiIsInZpZXciLCJlZGl0b3JMaXZlUHJldmlld0ZpZWxkIiwic2V0SWNvbiIsImVkaXRvckluZm9GaWVsZCIsIlRGaWxlIiwiUGx1Z2luU2V0dGluZ1RhYiIsIlNldHRpbmciLCJuZXQiXSwibWFwcGluZ3MiOiI7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQXNCQSxNQUFNLDJCQUEyQjtBQUNqQyxNQUFNLG1CQUEwQztBQUFBLEVBQzlDLFlBQVk7QUFBQSxFQUNa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
