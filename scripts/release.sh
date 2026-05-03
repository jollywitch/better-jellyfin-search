#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: scripts/release.sh <version> <changelog>"
  echo "Example: scripts/release.sh 0.1.31.0 \"Fix search pagination.\""
  exit 2
fi

VERSION="$1"
CHANGELOG="$2"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_FILE="$ROOT_DIR/Jellyfin.Plugin.BetterJellyfinSearch/Jellyfin.Plugin.BetterJellyfinSearch.csproj"
BUILD_FILE="$ROOT_DIR/build.yaml"
MANIFEST_FILE="$ROOT_DIR/repository/manifest.json"
PUBLISH_DIR="$ROOT_DIR/Jellyfin.Plugin.BetterJellyfinSearch/bin/Release/net9.0/publish"
DIST_DIR="$ROOT_DIR/dist"
ZIP_NAME="BetterJellyfinSearch_${VERSION}.zip"
ZIP_PATH="$DIST_DIR/$ZIP_NAME"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Version must look like 0.1.31.0"
  exit 2
fi

detect_repo() {
  if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
    echo "$GITHUB_REPOSITORY"
    return
  fi

  local remote_url
  remote_url="$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null || true)"
  if [[ "$remote_url" =~ github.com[:/]([^/]+/[^/.]+)(\.git)?$ ]]; then
    echo "${BASH_REMATCH[1]}"
    return
  fi

  echo ""
}

GITHUB_REPO="$(detect_repo)"
if [[ -z "$GITHUB_REPO" ]]; then
  echo "Set GITHUB_REPOSITORY=owner/repo or add a GitHub origin remote first."
  exit 2
fi

SOURCE_URL="https://github.com/${GITHUB_REPO}/releases/download/v${VERSION}/${ZIP_NAME}"

python3 - "$VERSION" "$CHANGELOG" "$PROJECT_FILE" "$BUILD_FILE" <<'PY'
import re
import sys
from pathlib import Path

version, changelog, project_file, build_file = sys.argv[1:]

project_path = Path(project_file)
project = project_path.read_text()
for tag in ("Version", "AssemblyVersion", "FileVersion"):
    project = re.sub(rf"<{tag}>[^<]+</{tag}>", f"<{tag}>{version}</{tag}>", project)
project_path.write_text(project)

build_path = Path(build_file)
lines = build_path.read_text().splitlines()
out = []
skip_changelog_continuation = False
for line in lines:
    if skip_changelog_continuation:
        if line.startswith("  "):
            continue
        skip_changelog_continuation = False

    if line.startswith("version:"):
        out.append(f'version: "{version}"')
    elif line.startswith("changelog:"):
        out.append("changelog: >")
        out.append(f"  {changelog}")
        skip_changelog_continuation = True
    else:
        out.append(line)
build_path.write_text("\n".join(out) + "\n")
PY

rm -rf "$PUBLISH_DIR"
dotnet publish "$ROOT_DIR/Jellyfin.Plugin.BetterJellyfinSearch.sln" -c Release

mkdir -p "$DIST_DIR"
rm -f "$ZIP_PATH"
(
  cd "$PUBLISH_DIR"
  zip -r "$ZIP_PATH" .
)

CHECKSUM="$(md5sum "$ZIP_PATH" | awk '{print $1}')"

echo "Release prepared:"
echo "  Version:  $VERSION"
echo "  Zip:      $ZIP_PATH"
echo "  Local checksum: $CHECKSUM"
echo "  URL:      $SOURCE_URL"
echo "  Manifest entry will be created by GitHub Actions with the GitHub-built zip checksum."
echo
echo "Next:"
echo "  git add Jellyfin.Plugin.BetterJellyfinSearch/Jellyfin.Plugin.BetterJellyfinSearch.csproj build.yaml"
echo "  git commit -m \"chore: release $VERSION\""
echo "  git tag v$VERSION"
echo "  git push origin main --tags"
echo "  git pull --ff-only"
