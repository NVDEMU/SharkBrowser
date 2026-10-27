# Shark Browser

Shark is an experimental cross-platform desktop web browser built with Electron and Chromium. It aims to provide real modern website rendering, tabbed browsing, privacy-focused ad and tracker blocking, and transparent blocking statistics.

## Features

- Chromium-based rendering for modern websites
- Tabs, address/search bar, navigation controls, and keyboard shortcuts
- Network-level ad and tracker blocking with per-site exceptions
- Live blocked-request statistics and recent blocking activity
- Bookmarks, history, downloads, and private windows
- Windows, macOS, and Linux builds via GitHub Actions

## Development

Requirements: Node.js 20 or newer and npm.

```sh
npm install
npm start
```

Create a local package with `npm run dist`. Platform installers are built on their respective GitHub Actions runners.

## Privacy and limitations

Shark is an early experimental browser, not yet a security-audited replacement for a mature browser. Do not use it for sensitive activity until it has undergone independent review. Blocking depends on filter lists and cannot catch every ad or tracker. Some sites may need a per-site exception.

## License

MIT
