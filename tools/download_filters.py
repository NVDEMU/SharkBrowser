#!/usr/bin/env python3
"""Fetch current EasyList/EasyPrivacy text files without making offline builds fail."""
from pathlib import Path
from urllib.request import Request, urlopen
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
FILTER_DIR = ROOT / "resources" / "filters"
SOURCES = {
    "easylist.txt": "https://easylist.to/easylist/easylist.txt",
    "easyprivacy.txt": "https://easylist.to/easylist/easyprivacy.txt",
}

def main() -> int:
    FILTER_DIR.mkdir(parents=True, exist_ok=True)
    failures = []
    for filename, url in SOURCES.items():
        target = FILTER_DIR / filename
        if target.exists() and target.stat().st_size > 100_000:
            print(f"Using existing {filename} ({target.stat().st_size:,} bytes)")
            continue
        for attempt in range(3):
            try:
                request = Request(url, headers={"User-Agent": "SharkBrowser/0.1 (EasyList-compatible filter updater)"})
                with urlopen(request, timeout=45) as response:
                    body = response.read()
                if len(body) < 100_000 or b"<!DOCTYPE html" in body[:1000]:
                    raise RuntimeError("server returned an unexpected or incomplete filter list")
                target.write_bytes(body)
                print(f"Downloaded {filename} ({len(body):,} bytes)")
                break
            except Exception as exc:
                print(f"Attempt {attempt + 1}/3 for {filename} failed: {exc}", file=sys.stderr)
                if attempt < 2:
                    time.sleep(2 * (attempt + 1))
        else:
            failures.append(filename)
    if failures:
        print("Warning: could not fetch " + ", ".join(failures) + "; the bundled fallback rules will still be shipped.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
