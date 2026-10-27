#!/usr/bin/env python3
"""Package the native CEF build into usable platform distributions."""
from pathlib import Path
import argparse
import os
import shutil
import subprocess
import sys
import tarfile

def find_release(build_dir: Path) -> Path:
    candidates = [build_dir / "Release", build_dir / "release", build_dir]
    for candidate in candidates:
        if candidate.exists() and any(candidate.iterdir()):
            return candidate
    raise FileNotFoundError(f"No CEF output directory found under {build_dir}")

def copy_tree_contents(source: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for item in source.iterdir():
        target = destination / item.name
        if item.is_dir():
            shutil.copytree(item, target, dirs_exist_ok=True, symlinks=True)
        elif item.is_file() or item.is_symlink():
            if target.exists() or target.is_symlink():
                target.unlink()
            if item.is_symlink():
                target.symlink_to(os.readlink(item))
            else:
                shutil.copy2(item, target)

def rename_executable(directory: Path, candidates: list[str], target_name: str) -> None:
    for candidate in candidates:
        source = directory / candidate
        if source.exists() and source.is_file():
            target = directory / target_name
            if source != target:
                if target.exists():
                    target.unlink()
                source.rename(target)
            if os.name != "nt":
                target.chmod(target.stat().st_mode | 0o111)
            return
    raise FileNotFoundError("Could not find CEF browser executable: " + ", ".join(candidates))

def package_windows(out: Path, dist: Path) -> list[Path]:
    root = dist / "SharkBrowser-Windows-x64"
    copy_tree_contents(out, root)
    rename_executable(root, ["cefsimple.exe", "SharkBrowser.exe"], "SharkBrowser.exe")
    (root / "README.txt").write_text(
        "Shark Browser (CEF)\n\nRun SharkBrowser.exe from this extracted folder. "
        "Do not move the executable out of this folder: Chromium runtime files must remain beside it.\n",
        encoding="utf-8"
    )
    archive = dist / "SharkBrowser-windows-x64.zip"
    shutil.make_archive(str(archive.with_suffix("")), "zip", root_dir=root.parent, base_dir=root.name)
    return [archive]

def package_linux(out: Path, dist: Path) -> list[Path]:
    root = dist / "SharkBrowser-Linux-x64"
    copy_tree_contents(out, root)
    rename_executable(root, ["cefsimple", "SharkBrowser"], "SharkBrowser")
    (root / "README.txt").write_text(
        "Shark Browser (CEF)\n\nRun ./SharkBrowser from this extracted folder. "
        "Keep all Chromium runtime files in this directory. On Debian/Ubuntu, install the system GTK/NSS/ALSA dependencies listed in the project README if needed.\n",
        encoding="utf-8"
    )
    archive = dist / "SharkBrowser-linux-x64.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        tar.add(root, arcname=root.name, recursive=True)
    return [archive]

def package_macos(out: Path, dist: Path) -> list[Path]:
    app_candidates = [out / "cefsimple.app", out / "SharkBrowser.app", out / "Shark Browser.app"]
    source = next((candidate for candidate in app_candidates if candidate.is_dir()), None)
    if source is None:
        # Some CEF generator configurations place app bundles directly in the build tree.
        found = list(out.glob("*.app"))
        source = found[0] if found else None
    if source is None:
        raise FileNotFoundError(f"No CEF .app bundle found in {out}")
    app = dist / "Shark Browser.app"
    if app.exists():
        shutil.rmtree(app)
    shutil.copytree(source, app, symlinks=True)
    zip_path = dist / "SharkBrowser-macos-arm64.zip"
    if zip_path.exists():
        zip_path.unlink()
    subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app), str(zip_path)], check=True)
    dmg_path = dist / "SharkBrowser-macos-arm64.dmg"
    if dmg_path.exists():
        dmg_path.unlink()
    subprocess.run(
        ["hdiutil", "create", "-volname", "Shark Browser", "-srcfolder", str(app),
         "-ov", "-format", "UDZO", str(dmg_path)],
        check=True
    )
    return [zip_path, dmg_path]

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--platform", choices=["windows", "macos", "linux"], required=True)
    parser.add_argument("--build-dir", type=Path, default=Path("build"))
    parser.add_argument("--output-dir", type=Path, default=Path("dist"))
    args = parser.parse_args()

    out = find_release(args.build_dir)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for child in args.output_dir.iterdir():
        if child.is_dir():
            shutil.rmtree(child)
        else:
            child.unlink()

    if args.platform == "windows":
        artifacts = package_windows(out, args.output_dir)
    elif args.platform == "macos":
        artifacts = package_macos(out, args.output_dir)
    else:
        artifacts = package_linux(out, args.output_dir)
    for artifact in artifacts:
        print(f"Created {artifact} ({artifact.stat().st_size:,} bytes)")
    return 0

if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"CEF packaging failed: {exc}", file=sys.stderr)
        raise
