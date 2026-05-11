# XGKB Sync

Sync Obsidian notes with 玄关知识库 (XGKB Knowledge Base).

## Features

- Sync notes between Obsidian and XGKB.
- Support bidirectional sync.
- Support syncing a specific folder or the whole vault.

## Installation

### Community Plugins (after review is approved)

1. Open Obsidian Settings.
2. Go to **Community plugins**.
3. Search for **XGKB Sync**.
4. Install and enable the plugin.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub Release.
2. Create folder: `.obsidian/plugins/cms-xgkb-sync/`
3. Put those files into that folder.
4. Restart Obsidian and enable **XGKB Sync**.

## Configuration

After enabling the plugin, open plugin settings and configure:

- Server URL
- App Key
- Sync folder / direction

## Compatibility

- `minAppVersion`: `1.0.0`
- Plugin ID: `cms-xgkb-sync`

## Development

```bash
npm install
npm run build
```

## License

MIT
