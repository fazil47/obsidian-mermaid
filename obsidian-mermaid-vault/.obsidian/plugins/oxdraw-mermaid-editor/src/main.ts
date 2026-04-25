import {
  App,
  editorInfoField,
  editorLivePreviewField,
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  ViewStateResult,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as net from "net";
import * as os from "os";
import * as path from "path";

const VIEW_TYPE_OXDRAW_MERMAID = "oxdraw-mermaid-editor-view";
const DEFAULT_SETTINGS: OxdrawMermaidSettings = {
  oxdrawPath: "oxdraw",
  startingPort: 5151,
};

interface OxdrawMermaidSettings {
  oxdrawPath: string;
  startingPort: number;
}

interface MermaidBlock {
  startLine: number;
  endLine: number;
  charStart: number;
  charEnd: number;
  openLine: string;
  closeLine: string;
  body: string;
  blockText: string;
  hash: string;
}

interface EditorSession {
  id: string;
  sourcePath: string;
  sourceFile: TFile;
  lineStart: number;
  lineEnd: number;
  originalHash: string;
  tempDir: string;
  tempFile: string;
  logFile: string;
  port: number;
  url: string;
  process: ChildProcessWithoutNullStreams;
}

interface OxdrawViewState extends Record<string, unknown> {
  sessionId?: string;
}

export default class OxdrawMermaidPlugin extends Plugin {
  settings: OxdrawMermaidSettings = DEFAULT_SETTINGS;
  private sessions = new Map<string, EditorSession>();

  async onload() {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_OXDRAW_MERMAID,
      (leaf) => new OxdrawMermaidView(leaf, this),
    );

    this.registerEditorExtension(createMermaidEditorExtension(this));

    this.addSettingTab(new OxdrawMermaidSettingTab(this.app, this));
  }

  async onunload() {
    for (const session of this.sessions.values()) {
      await this.closeSession(session.id);
    }
  }

  getSession(id: string): EditorSession | undefined {
    return this.sessions.get(id);
  }

  async saveSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      new Notice("Oxdraw session not found.");
      return;
    }

    const response = await fetch(`${session.url}/api/diagram/source`, {
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`Unable to read oxdraw source: ${response.status}`);
    }

    const payload = (await response.json()) as { source?: string };
    const cleanBody = stripOxdrawComments(payload.source ?? "");
    await this.replaceOriginalBlock(session, cleanBody);
    new Notice("Saved clean Mermaid back to the note.");
  }

  async closeSession(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }
    this.sessions.delete(sessionId);

    if (!session.process.killed) {
      session.process.kill();
    }

    try {
      await fs.rm(session.tempDir, { recursive: true, force: true });
    } catch {
      // Temp cleanup failure should not block Obsidian shutdown.
    }
  }

  async loadSettings() {
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(await this.loadData()),
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async openEditorForBlock(file: TFile, block: MermaidBlock) {
    const session = await this.startOxdrawSession(file, block);
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({
      type: VIEW_TYPE_OXDRAW_MERMAID,
      active: true,
      state: { sessionId: session.id } satisfies OxdrawViewState,
    });
  }

  private async startOxdrawSession(file: TFile, block: MermaidBlock): Promise<EditorSession> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "obsidian-oxdraw-"));
    const tempFile = path.join(tempDir, "diagram.mmd");
    const logFile = path.join(tempDir, "oxdraw.log");
    await fs.writeFile(tempFile, `${block.body.trimEnd()}\n`, "utf8");

    const port = await findOpenPort(this.settings.startingPort);
    const args = [
      "--input",
      tempFile,
      "--edit",
      "--serve-host",
      "127.0.0.1",
      "--serve-port",
      String(port),
    ];

    const env = buildOxdrawEnv();
    const child = spawn(this.settings.oxdrawPath, args, { env });
    const sessionId = crypto.randomUUID();
    const session: EditorSession = {
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
      process: child,
    };

    let startupError = "";
    await appendLaunchLog(logFile, [
      `time=${new Date().toISOString()}`,
      `command=${this.settings.oxdrawPath} ${args.join(" ")}`,
      `sourcePath=${file.path}`,
      `tempFile=${tempFile}`,
      `url=${session.url}`,
      `PATH=${env.PATH ?? ""}`,
      "",
    ]);

    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString();
      startupError += text;
      void appendLaunchLog(logFile, [`[stderr] ${text}`]);
      console.error(`[oxdraw:${sessionId}] ${text}`);
    });
    child.stdout.on("data", (data: Buffer) => {
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

  private async replaceOriginalBlock(session: EditorSession, newBody: string) {
    await this.app.vault.process(session.sourceFile, (currentSource) => {
      const blocks = parseMermaidBlocks(currentSource);
      const originalAtLocation = blocks.find(
        (block) =>
          block.startLine === session.lineStart &&
          block.endLine === session.lineEnd &&
          block.hash === session.originalHash,
      );
      const originalByHash = blocks.find((block) => block.hash === session.originalHash);
      const block = originalAtLocation ?? originalByHash;

      if (!block) {
        throw new Error(
          "The original Mermaid block changed while oxdraw was open. Close this editor and reopen it from the current note.",
        );
      }

      const replacement = `${block.openLine}\n${newBody.trimEnd()}\n${block.closeLine}`;
      return currentSource.replace(block.blockText, replacement);
    });
  }
}

class OxdrawMermaidView extends ItemView {
  private plugin: OxdrawMermaidPlugin;
  private sessionId: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: OxdrawMermaidPlugin) {
    super(leaf);
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

  async setState(state: OxdrawViewState, result: ViewStateResult) {
    await super.setState(state, result);
    this.sessionId = state.sessionId ?? null;
    this.render();
  }

  getState(): OxdrawViewState {
    return {
      sessionId: this.sessionId ?? undefined,
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

  private render() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("oxdraw-mermaid-view");

    if (!this.sessionId) {
      containerEl.createDiv({
        cls: "oxdraw-mermaid-empty",
        text: "No oxdraw session is attached to this view.",
      });
      return;
    }

    const session = this.plugin.getSession(this.sessionId);
    if (!session) {
      containerEl.createDiv({
        cls: "oxdraw-mermaid-empty",
        text: "This oxdraw session has ended.",
      });
      return;
    }

    const toolbar = containerEl.createDiv({ cls: "oxdraw-mermaid-toolbar" });
    toolbar.createDiv({
      cls: "oxdraw-mermaid-title",
      text: `${session.sourcePath}:${session.lineStart + 1}`,
    });

    const saveButton = toolbar.createEl("button", { text: "Save clean Mermaid" });
    saveButton.addEventListener("click", async () => {
      saveButton.disabled = true;
      try {
        await this.plugin.saveSession(session.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Unable to save Mermaid: ${message}`);
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
        sandbox:
          "allow-downloads allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts",
      },
    });
  }
}

function createMermaidEditorExtension(plugin: OxdrawMermaidPlugin) {
  return ViewPlugin.fromClass(
    class MermaidEditorButtonPlugin {
      private view: EditorView;
      private observer: MutationObserver;
      private animationFrame: number | null = null;

      constructor(view: EditorView) {
        this.view = view;
        this.observer = new MutationObserver(() => this.scheduleScan());
        this.observer.observe(view.dom, { childList: true, subtree: true });
        this.scheduleScan();
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet ||
          update.geometryChanged
        ) {
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

      private scheduleScan() {
        if (this.animationFrame !== null) {
          return;
        }
        this.animationFrame = window.requestAnimationFrame(() => {
          this.animationFrame = null;
          this.scan();
        });
      }

      private scan() {
        if (!this.view.state.field(editorLivePreviewField, false)) {
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
              type: "button",
            },
          });
          setIcon(button, "pencil-ruler");

          button.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();

            try {
              const info = this.view.state.field(editorInfoField);
              const file = info.file;
              if (!(file instanceof TFile)) {
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
              new Notice(`Unable to open oxdraw editor: ${message}`);
              console.error(error);
            }
          });
        }
      }

      private removeButtons() {
        this.view.dom.querySelectorAll(".oxdraw-mermaid-edit-button").forEach((button) => {
          button.remove();
        });
      }
    },
  );
}

function findMermaidBlockForElement(
  source: string,
  view: EditorView,
  mermaidEl: HTMLElement,
  host: HTMLElement,
): MermaidBlock | null {
  const blocks = parseMermaidBlocks(source);
  if (blocks.length === 0) {
    return null;
  }

  const pos = getElementDocumentPosition(view, mermaidEl) ?? getElementDocumentPosition(view, host);
  if (pos !== null) {
    const containing = blocks.find((block) => pos >= block.charStart && pos <= block.charEnd);
    if (containing) {
      return containing;
    }

    return blocks
      .slice()
      .sort(
        (a, b) =>
          distanceToRange(pos, a.charStart, a.charEnd) -
          distanceToRange(pos, b.charStart, b.charEnd),
      )[0];
  }

  return blocks[0];
}

function getElementDocumentPosition(view: EditorView, element: HTMLElement): number | null {
  try {
    return view.posAtDOM(element);
  } catch {
    return null;
  }
}

function distanceToRange(pos: number, start: number, end: number): number {
  if (pos < start) {
    return start - pos;
  }
  if (pos > end) {
    return pos - end;
  }
  return 0;
}

class OxdrawMermaidSettingTab extends PluginSettingTab {
  private plugin: OxdrawMermaidPlugin;

  constructor(app: App, plugin: OxdrawMermaidPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Oxdraw binary path")
      .setDesc("Use 'oxdraw' if it is available on Obsidian's PATH.")
      .addText((text) => {
        text
          .setPlaceholder("oxdraw")
          .setValue(this.plugin.settings.oxdrawPath)
          .onChange(async (value) => {
            this.plugin.settings.oxdrawPath = value.trim() || "oxdraw";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Starting port")
      .setDesc("The plugin will use this port or the next available port.")
      .addText((text) => {
        text
          .setPlaceholder("5151")
          .setValue(String(this.plugin.settings.startingPort))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
              this.plugin.settings.startingPort = parsed;
              await this.plugin.saveSettings();
            }
          });
      });
  }
}

function findRenderedMermaidElements(root: HTMLElement): HTMLElement[] {
  const selectors = [
    ".mermaid",
    ".block-language-mermaid",
    ".language-mermaid",
    "pre:has(code.language-mermaid)",
    "svg[id^='mermaid-']",
    "svg[aria-roledescription]",
  ];
  const seen = new Set<HTMLElement>();
  const results: HTMLElement[] = [];

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

function pickButtonHost(element: HTMLElement): HTMLElement | null {
  const markdownSection = element.closest(".el-pre, .markdown-preview-section > div");
  if (markdownSection instanceof HTMLElement) {
    return markdownSection;
  }

  const codeBlock = element.closest("pre");
  if (codeBlock instanceof HTMLElement) {
    return codeBlock;
  }

  if (
    element.classList.contains("mermaid") ||
    element.classList.contains("block-language-mermaid")
  ) {
    return element;
  }

  return element.parentElement instanceof HTMLElement ? element.parentElement : element;
}

function parseMermaidBlocks(source: string): MermaidBlock[] {
  const lines = source.split("\n");
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }

  const blocks: MermaidBlock[] = [];

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
          hash: hashText(blockText),
        });
        index = end;
        break;
      }
      end += 1;
    }
  }

  return blocks;
}

function stripOxdrawComments(source: string): string {
  const lines = source.split(/\r?\n/);
  const output: string[] = [];
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

function hashText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function buildOxdrawEnv(): NodeJS.ProcessEnv {
  const existingPath = process.env.PATH ?? "";
  const home = os.homedir();
  const extraPaths = [
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const pathParts = [...extraPaths, existingPath].filter(Boolean);

  return {
    ...process.env,
    PATH: pathParts.join(":"),
  };
}

async function findOpenPort(startingPort: number): Promise<number> {
  for (let port = startingPort; port < startingPort + 100; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No open port found starting at ${startingPort}.`);
}

async function appendLaunchLog(logFile: string, lines: string[]) {
  try {
    await fs.appendFile(logFile, `${lines.join("\n")}\n`, "utf8");
  } catch (error) {
    console.error(`Unable to write oxdraw launch log '${logFile}'.`, error);
  }
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function waitForOxdraw(
  baseUrl: string,
  child: ChildProcessWithoutNullStreams,
  getStartupError: () => string,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const detail = getStartupError().trim();
      const fallback =
        child.exitCode === -2
          ? "Could not start oxdraw. Set the plugin's Oxdraw binary path to the full executable path."
          : `oxdraw exited with code ${child.exitCode}`;
      throw new Error(detail || fallback);
    }

    try {
      const response = await fetch(`${baseUrl}/api/diagram/source`, {
        cache: "no-store",
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Server is not ready yet.
    }

    await sleep(150);
  }

  throw new Error("Timed out waiting for oxdraw to start.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
