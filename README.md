# Shark Browser

Shark is an experimental cross-platform desktop browser built in **C++ with Chromium Embedded Framework (CEF)**. It no longer uses Electron. CEF supplies Chromium's HTML/CSS/JavaScript rendering engine and the native browser process; Shark owns the tab strip, navigation toolbar, profile data, filter rules, and privacy dashboard.

## Current native features

- CEF/Chromium website rendering with normal JavaScript, modern CSS, video, and multi-process rendering
- Multi-tab browsing, new tab, close tab, tab selection, back, forward, reload, home, address/search field, and common Ctrl/Cmd keyboard shortcuts
- Search/address normalization through DuckDuckGo when the text is not a URL
- Private tabs use a separate in-memory CEF request context; private browsing requests are not added to the history or blocking statistics
- Network-request blocking with built-in fallback rules plus optional EasyList and EasyPrivacy domain rules
- Privacy dashboard with total/ad/tracker counts, blocked requests, site breakdown, and a global protection toggle
- Persistent bookmarks, browsing history, home-page setting, allow-site exceptions, and block statistics
- CEF-managed downloads with the platform's save-file dialog and a native downloads page
- Internal home, bookmarks, history, downloads, privacy, find-in-page, and settings pages
- CEF's context menu, Chromium cookies/site storage, and standard web permissions

## Build requirements

The CEF binary distribution is downloaded automatically by CMake. Builds are large because CEF ships the actual Chromium runtime, shared libraries, resources, locale files, and helper process support.

- CMake 3.21+
- Python 3.11
- A C++17 toolchain (Visual Studio 2022 on Windows, Xcode on macOS, or Clang/GCC on Linux)
- Ninja on Linux (recommended)
- On Linux, Chromium's GTK/NSS/ALSA/X11/GBM development packages. See the workflow for the tested package list.

### Build on Windows

Run from a Visual Studio 2022 developer terminal:

```powershell
python tools/download_filters.py
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release --target cefsimple --parallel 2
python tools/package_cef.py --platform windows --build-dir build --output-dir dist
```

### Build on macOS (Apple Silicon)

```sh
python3 tools/download_filters.py
cmake -S . -B build -G Xcode -DPROJECT_ARCH=arm64
cmake --build build --config Release --target cefsimple --parallel 2
python3 tools/package_cef.py --platform macos --build-dir build --output-dir dist
```

The package step creates a `.app`, a ZIP, and a DMG. The app is currently **unsigned and not notarized**, so macOS may show a security warning. A Developer ID certificate is required for a fully signed/notarized release.

### Build on Linux (x86-64)

Install the native CEF build dependencies listed in `.github/workflows/build.yml`, then run:

```sh
python3 tools/download_filters.py
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build --target cefsimple --parallel 2
python3 tools/package_cef.py --platform linux --build-dir build --output-dir dist
```

The output is a TAR.GZ containing the Shark executable and its required Chromium files. Keep all files together after extraction.

## Automated builds

GitHub Actions builds Windows x64, macOS arm64, and Linux x64 on pushes to `main`, pull requests, and manual dispatch. Tag a version with `v*` to publish the generated packages as GitHub Release assets.

## Blocking engine and known limitations

Shark currently parses the **domain-based subset** of EasyList/EasyPrivacy rules (downloaded at build time) and supplements those rules with built-in fallbacks and URL path heuristics. This is not full Adblock Plus/uBlock Origin filter-list semantics: cosmetic filters, scriptlets, complex exception conditions, and every URL-pattern rule are not supported yet. A request that is blocked is counted once when CEF cancels it; this is a practical statistic, not a claim that all ads or trackers are detected.

This is an early browser prototype, not a security-audited replacement for a mature browser. Chrome Web Store extension installation, full Chrome extension API compatibility, synchronized profiles, a production password manager, automatic profile recovery, and complete session restore are not implemented. The browser should not yet be used for sensitive activity.

## CEF

Shark uses CEF's binary distributions instead of building Chromium from source. CEF and its included Chromium components retain their own licenses and notices; see the CEF distribution's `LICENSE.txt` and Chromium third-party notices bundled with each build.
