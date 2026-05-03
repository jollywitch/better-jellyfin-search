# Better Jellyfin Search

![Better Jellyfin Search thumbnail](repository/images/better-jellyfin-search.png)

Better Jellyfin Search is a Jellyfin plugin that replaces the default Jellyfin Web search results presentation with a grid-oriented search UI. It keeps the normal Jellyfin URL, Jellyfin session, and Jellyfin backend search behavior while changing how search results are displayed in the browser.

## Purpose

This project is intended for Jellyfin Web users who want a denser, category-based search results page. It adds tabs for item types such as movies, shows, videos, photos, playlists, and folders, and renders matching items as thumbnail grids with pagination.

The plugin affects Jellyfin Web only. It does not modify the Jellyfin search backend, media library, native apps, TV apps, or mobile apps.

## How It Works

The Jellyfin plugin serves a browser script, stylesheet, and public read-only runtime config from the Jellyfin server:

- `/BetterJellyfinSearch/better-jellyfin-search.js`
- `/BetterJellyfinSearch/better-jellyfin-search.css`
- `/BetterJellyfinSearch/bootstrap`
- `/BetterJellyfinSearch/config`

Jellyfin Web itself is not rebuilt or replaced. Instead, the existing Jellyfin reverse proxy injects a small loader into Jellyfin Web HTML responses with Nginx `sub_filter`. The loader checks the plugin config, reads the installed plugin version, and loads the stylesheet and main script with a versioned URL. Once loaded in the browser, the main script detects Jellyfin Web search pages and replaces the default search results area with the Better Jellyfin Search view.

## Installation

### Option 1: Install From Plugin Repository

In Jellyfin, open:

```text
Dashboard -> Plugins -> Repositories
```

Add this repository URL:

```text
https://raw.githubusercontent.com/jollywitch/better-jellyfin-search/main/repository/manifest.json
```

Then install `Better Jellyfin Search` from the plugin catalog and restart Jellyfin.

### Option 2: Build and Install Manually

Build the plugin with the .NET SDK:

```bash
dotnet publish Jellyfin.Plugin.BetterJellyfinSearch.sln -c Release
```

Copy the published plugin files from:

```text
Jellyfin.Plugin.BetterJellyfinSearch/bin/Release/net9.0/publish/
```

into a Jellyfin plugin folder, then restart Jellyfin. The exact plugin directory depends on the Jellyfin installation method and operating system.

### Add the Nginx Snippet

Add this snippet to the existing Jellyfin Nginx reverse proxy `location` block that serves Jellyfin Web:

```nginx
gzip off;
gunzip on;
proxy_set_header Accept-Encoding "";

sub_filter_types text/html;
sub_filter_once off;

sub_filter '</body>' '<script defer src="/BetterJellyfinSearch/bootstrap"></script></body>';
```

For Nginx Proxy Manager, put the snippet in a custom location for `/` when the normal Advanced tab does not place the directives inside the generated `location /` block.

Do not inject `/BetterJellyfinSearch/better-jellyfin-search.js` or `/BetterJellyfinSearch/better-jellyfin-search.css` directly from Nginx. The stable bootstrap script reads `/BetterJellyfinSearch/config` and then loads the versioned assets, for example `/BetterJellyfinSearch/better-jellyfin-search.js?v=<installed-version>`. This avoids stale browser or proxy caches after plugin updates and lets Jellyfin fall back to the normal search page when the plugin is disabled or removed while the Nginx snippet is still present.

After changing Nginx, test and reload:

```bash
nginx -t && systemctl reload nginx
```

Confirm the plugin endpoints are reachable through the same Jellyfin origin:

```text
https://your-jellyfin.example.com/BetterJellyfinSearch/config
https://your-jellyfin.example.com/BetterJellyfinSearch/bootstrap
https://your-jellyfin.example.com/BetterJellyfinSearch/better-jellyfin-search.js
https://your-jellyfin.example.com/BetterJellyfinSearch/better-jellyfin-search.css
```

Confirm the injection is present:

```bash
curl -s \
  -H 'Accept-Encoding: gzip, deflate, br' \
  https://your-jellyfin.example.com/web/ | grep BetterJellyfinSearch
```

Do not add a new Jellyfin URL, custom `jellyfin-web` build, extra container port, or version-specific web directory.

## Runtime Behavior

- `GET /BetterJellyfinSearch/bootstrap` returns the stable injected bootstrap script.
- `GET /BetterJellyfinSearch/better-jellyfin-search.js` returns the embedded main script.
- `GET /BetterJellyfinSearch/better-jellyfin-search.css` returns the embedded stylesheet.
- `GET /BetterJellyfinSearch/config` returns public settings: enabled state, page size, section mode, and included item types.
- Search queries use the active Jellyfin Web `window.ApiClient` session with `recursive=true`, `searchTerm`, `includeItemTypes`, `limit`, `startIndex`, and `enableTotalRecordCount=true`.

## Compatibility Notes

The injected script depends on Jellyfin Web retaining `#searchPage`, `#searchTextInput`, and `.searchResults`. If Jellyfin Web changes those selectors, the plugin will leave the page unchanged rather than replacing unrelated content.
