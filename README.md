# Oxdraw Mermaid Editor

Prototype Obsidian plugin for editing Mermaid code blocks in a visual oxdraw editor.

The plugin adds an edit button to Mermaid blocks in Live Preview. Clicking it opens an oxdraw editor tab. Saving writes clean Mermaid back to the original fenced code block.

## Requirements

- Obsidian desktop. This plugin is desktop-only because it starts a local `oxdraw` process.
- `oxdraw` installed on your machine and available on `PATH`.

Install oxdraw from the fork currently used by this prototype:

```bash
cargo install --git https://github.com/fazil47/oxdraw.git --force oxdraw
```

If Obsidian cannot find `oxdraw`, open the plugin settings and set the full binary path, for example:

```text
/Users/you/.cargo/bin/oxdraw
```

## Manual Install

Download these files from a GitHub release:

- `manifest.json`
- `main.js`
- `styles.css`

Create this folder in your vault:

```text
<your-vault>/.obsidian/plugins/oxdraw-mermaid-editor/
```

Place the downloaded files in that folder, then restart Obsidian or reload plugins. Enable **Oxdraw Mermaid Editor** under Community plugins.

## Development

Install dependencies:

```bash
npm install
```

Build the plugin:

```bash
npm run build
```

The dev/test vault lives in `obsidian-mermaid-vault/`. For local testing, copy or symlink the root plugin files into:

```text
obsidian-mermaid-vault/.obsidian/plugins/oxdraw-mermaid-editor/
```

## Release Checklist

For a manual beta release:

1. Update `manifest.json`, `package.json`, and `versions.json`.
2. Run `npm run build`.
3. Create a GitHub release whose tag exactly matches `manifest.json.version`, for example `0.1.0`.
4. Upload `manifest.json`, `main.js`, and `styles.css` as release assets.

Obsidian community-plugin releases use the same artifact shape.
