(function () {
    "use strict";

    var CONFIG_URL = "/BetterJellyfinSearch/config";
    var CSS_URL = "/BetterJellyfinSearch/better-jellyfin-search.css";
    var ROOT_CLASS = "better-jellyfin-search-root";
    var SCROLL_STORAGE_PREFIX = "better-jellyfin-search-scroll:";
    var SORT_STORAGE_KEY = "better-jellyfin-search-sort";
    var CLIENT_SORT_BATCH_SIZE = 500;
    var DEFAULT_TYPES = ["Movie", "Series", "Episode", "MusicAlbum", "Audio", "BoxSet", "Playlist", "Video", "Photo", "Folder"];
    var TYPE_LABELS = {
        Movie: "Movies",
        Series: "Shows",
        Episode: "Episodes",
        MusicAlbum: "Albums",
        Audio: "Songs",
        BoxSet: "Collections",
        Playlist: "Playlists",
        Video: "Videos",
        Photo: "Photos",
        Folder: "Folders"
    };
    var TYPE_ORDER = DEFAULT_TYPES.concat(["MusicArtist", "Person"]);
    var SORT_OPTIONS = [
        { value: "SortName", label: "Name" },
        { value: "DateCreated", label: "Date Added" },
        { value: "DatePlayed", label: "Date Played" },
        { value: "Runtime", label: "Runtime" },
        { value: "PlayCount", label: "Play Count" }
    ];
    var NAME_COLLATOR = new Intl.Collator(undefined, {
        numeric: true,
        sensitivity: "base"
    });
    var state = {
        config: null,
        query: "",
        activeType: "",
        sortBy: getStoredSort().sortBy,
        sortOrder: getStoredSort().sortOrder,
        sortMenuOpen: false,
        availableTypes: [],
        typeCounts: {},
        countsLoading: false,
        stylesheetReady: false,
        sections: {},
        results: null,
        searchPage: null,
        resultsElement: null,
        root: null,
        hiddenElements: [],
        debounceTimer: 0,
        requestId: 0,
        lastRouteKey: "",
        suppressNextLocationChange: false
    };

    prehideSearchUi();

    function isSearchLocation() {
        return /(^|\/)search(\.html)?(?:[?#]|$)/i.test(window.location.pathname)
            || /(?:^|[#!?/])search(?:\.html)?(?:[?/&?#]|$)/i.test(window.location.hash);
    }

    function prehideSearchUi() {
        document.documentElement.classList.toggle("better-jellyfin-search-booting", isSearchLocation());
    }

    function waitFor(condition, timeoutMs) {
        var started = Date.now();

        return new Promise(function (resolve, reject) {
            function check() {
                var value = condition();
                if (value) {
                    resolve(value);
                    return;
                }

                if (Date.now() - started >= timeoutMs) {
                    reject(new Error("Timed out waiting for Jellyfin search page"));
                    return;
                }

                window.setTimeout(check, 100);
            }

            check();
        });
    }

    function getApiClient() {
        return window.ApiClient || null;
    }

    function findServerCredentials(value) {
        if (!value || typeof value !== "object") {
            return null;
        }

        if (value.AccessToken || value.accessToken) {
            return value;
        }

        var servers = Array.isArray(value.Servers) ? value.Servers : value.servers;
        if (Array.isArray(servers)) {
            var origin = window.location.origin.toLowerCase();
            var matchingServer = servers.find(function (server) {
                return [server.ManualAddress, server.LocalAddress, server.RemoteAddress]
                    .filter(Boolean)
                    .some(function (address) {
                        return String(address).toLowerCase().replace(/\/+$/, "") === origin;
                    });
            });

            return matchingServer || servers.find(function (server) {
                return server.AccessToken || server.accessToken;
            }) || null;
        }

        return null;
    }

    function getStoredCredentials() {
        for (var index = 0; index < localStorage.length; index += 1) {
            var key = localStorage.key(index);
            if (!key || key.toLowerCase().indexOf("credential") === -1) {
                continue;
            }

            try {
                var credentials = findServerCredentials(JSON.parse(localStorage.getItem(key)));
                if (credentials && (credentials.AccessToken || credentials.accessToken)) {
                    return credentials;
                }
            } catch (error) {
                continue;
            }
        }

        return null;
    }

    function hasApiAccess() {
        return Boolean(getApiClient() || getStoredCredentials());
    }

    function getSearchTextInput() {
        return document.querySelector("#searchTextInput, input.searchTextInput, #txtSearch");
    }

    function getSearchPage() {
        var input = getSearchTextInput();
        return document.querySelector("#searchPage")
            || input && input.closest("[data-role='page']")
            || input && input.closest(".page")
            || input && input.closest("main");
    }

    function getResultsElement(page) {
        if (!page) {
            return null;
        }

        var existingAnchor = page.querySelector(".better-jellyfin-search-anchor");
        if (existingAnchor) {
            return existingAnchor;
        }

        var resultSelectors = [
            ".searchResults",
            ".searchResultsContainer",
            ".searchPageResult",
            ".itemsContainer",
            "[is='emby-itemscontainer']"
        ];
        var originalResults = null;

        for (var index = 0; index < resultSelectors.length; index += 1) {
            var element = page.querySelector(resultSelectors[index]);
            if (element) {
                originalResults = element;
                break;
            }
        }

        var anchor = document.createElement("div");
        anchor.className = "better-jellyfin-search-anchor";
        if (originalResults && originalResults.parentElement) {
            originalResults.insertAdjacentElement("beforebegin", anchor);
            return anchor;
        }

        var input = getSearchTextInput();
        var inputBlock = input && (input.closest(".inputContainer, .searchFields, form, .section, .verticalSection")
            || input.parentElement);
        if (!inputBlock) {
            page.appendChild(anchor);
            return anchor;
        }

        var insertionTarget = inputBlock;
        while (insertionTarget.parentElement
            && insertionTarget.parentElement !== page
            && insertionTarget.parentElement !== document.body) {
            insertionTarget = insertionTarget.parentElement;
        }

        insertionTarget.insertAdjacentElement("afterend", anchor);
        return anchor;
    }

    function hideElement(element) {
        if (!element || element.closest("." + ROOT_CLASS) || element.classList.contains("better-jellyfin-search-anchor")) {
            return;
        }

        if (!element.dataset.betterJellyfinSearchPreviousDisplay) {
            element.dataset.betterJellyfinSearchPreviousDisplay = element.style.display || "__empty__";
            state.hiddenElements.push(element);
        }

        element.style.display = "none";
    }

    function restoreHiddenElements() {
        state.hiddenElements.forEach(function (element) {
            if (!element || !element.isConnected) {
                return;
            }

            var previousDisplay = element.dataset.betterJellyfinSearchPreviousDisplay;
            element.style.display = previousDisplay === "__empty__" ? "" : previousDisplay;
            delete element.dataset.betterJellyfinSearchPreviousDisplay;
        });
        state.hiddenElements = [];
    }

    function hideOriginalResults(page) {
        if (!page) {
            return;
        }

        var input = getSearchTextInput();
        [
            ".searchResults",
            ".searchResultsContainer",
            ".searchPageResult",
            ".itemsContainer",
            "[is='emby-itemscontainer']",
            ".searchfields-icon",
            ".noItemsMessage",
            ".noItems",
            ".emptyMessage",
            ".centerMessage",
            ".sectionTitle",
            ".searchSuggestions",
            ".verticalSection.searchSuggestions",
            ".searchSuggestionsList"
        ].forEach(function (selector) {
            Array.prototype.slice.call(page.querySelectorAll(selector)).forEach(function (element) {
                if (input && element.contains(input)) {
                    return;
                }

                hideElement(element);
            });
        });

        Array.prototype.slice.call(page.querySelectorAll("div, p, span")).forEach(function (element) {
            var text = (element.textContent || "").trim();
            if (!text || text.length > 120 || element.children.length > 2) {
                return;
            }

            if (/검색 결과가 없습니다|No results found|^제안$|^Suggestions$/i.test(text)) {
                hideElement(element);
            }
        });

        hideOriginalSuggestions(page);
    }

    function isSuggestionTitle(element) {
        var text = (element.textContent || "").trim();
        return /^제안$|^Suggestions$/i.test(text);
    }

    function hideSuggestionSiblings(title) {
        var sibling = title.nextElementSibling;
        while (sibling) {
            if (sibling.closest("." + ROOT_CLASS) || sibling.classList.contains("better-jellyfin-search-anchor")) {
                break;
            }

            if (sibling.matches(".sectionTitle, h1, h2, h3") && !isSuggestionTitle(sibling)) {
                break;
            }

            hideElement(sibling);
            sibling = sibling.nextElementSibling;
        }
    }

    function hideOriginalSuggestions(page) {
        var candidates = Array.prototype.slice.call(page.querySelectorAll(
            ".sectionTitle, h1, h2, h3, .verticalSection, .section, .searchSuggestionsList, [class*='suggest'], [class*='Suggestion']"
        ));

        candidates.forEach(function (element) {
            if (element.closest("." + ROOT_CLASS) || element.classList.contains("better-jellyfin-search-anchor")) {
                return;
            }

            if (element.classList.contains("searchSuggestions")
                || element.classList.contains("searchSuggestionsList")) {
                hideElement(element);
                return;
            }

            if (!isSuggestionTitle(element)) {
                return;
            }

            var container = element.closest(".verticalSection, .section");
            if (container && container !== page && !container.contains(getSearchTextInput())) {
                hideElement(container);
                return;
            }

            hideElement(element);
            hideSuggestionSiblings(element);
        });
    }

    function hideOriginalSearchInput() {
        var input = getSearchTextInput();
        var inputBlock = input && (input.closest(".inputContainer, .searchFields, form")
            || input.parentElement);
        if (inputBlock) {
            hideElement(inputBlock);
        }
    }

    function getSearchTerm() {
        var locationTerm = getRouteParams().term;
        if (locationTerm) {
            return locationTerm;
        }

        var input = getSearchTextInput();
        if (input && typeof input.value === "string") {
            return input.value.trim();
        }

        return "";
    }

    function getRouteParams() {
        var hashQuery = window.location.hash.indexOf("?") === -1
            ? ""
            : window.location.hash.slice(window.location.hash.indexOf("?") + 1);
        var params = new URLSearchParams(window.location.search || hashQuery);
        var startIndex = Number(params.get("startIndex") || params.get("start") || 0);
        if (!Number.isFinite(startIndex) || startIndex < 0) {
            startIndex = 0;
        }

        return {
            term: (params.get("query") || params.get("searchTerm") || "").trim(),
            type: (params.get("type") || "").trim(),
            startIndex: Math.floor(startIndex)
        };
    }

    function getStoredSort() {
        try {
            var value = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) || "null");
            if (value && typeof value === "object") {
                return {
                    sortBy: normalizeSortBy(value.sortBy),
                    sortOrder: normalizeSortOrder(value.sortOrder)
                };
            }
        } catch (error) {
            return {
                sortBy: "DateCreated",
                sortOrder: "Descending"
            };
        }

        return {
            sortBy: "DateCreated",
            sortOrder: "Descending"
        };
    }

    function storeSort(sortBy, sortOrder) {
        try {
            localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify({
                sortBy: normalizeSortBy(sortBy),
                sortOrder: normalizeSortOrder(sortOrder)
            }));
        } catch (error) {
            return;
        }
    }

    function normalizeSortBy(value) {
        var candidate = (value || "").trim();
        return SORT_OPTIONS.some(function (option) {
            return option.value === candidate;
        }) ? candidate : "DateCreated";
    }

    function normalizeSortOrder(value) {
        return String(value || "").toLowerCase() === "ascending" ? "Ascending" : "Descending";
    }

    function getSortLabel(value) {
        var option = SORT_OPTIONS.find(function (candidate) {
            return candidate.value === value;
        });
        return option ? option.label : "Date Added";
    }

    function getRouteKey(term, type, startIndex) {
        return [
            window.location.pathname,
            term || "",
            type || "",
            String(startIndex || 0),
            state.sortBy,
            state.sortOrder
        ].join("|");
    }

    function updateSearchRoute(term, type, startIndex) {
        if (!isSearchLocation()) {
            return;
        }

        var query = new URLSearchParams();
        if (term) {
            query.set("query", term);

            if (type) {
                query.set("type", type);
            }

            if (startIndex) {
                query.set("startIndex", String(startIndex));
            }
        }

        var nextQuery = query.toString();
        var nextHash = "#/search" + (nextQuery ? "?" + nextQuery : "");
        var nextUrl = window.location.pathname + window.location.search + nextHash;
        if (window.location.hash === nextHash) {
            return;
        }

        state.suppressNextLocationChange = true;
        history.replaceState(history.state, document.title, nextUrl);
    }

    function getEnabledTypes() {
        var configured = state.config && Array.isArray(state.config.includeItemTypes)
            ? state.config.includeItemTypes
            : DEFAULT_TYPES;
        return configured.filter(Boolean);
    }

    function getActiveType() {
        var visibleTypes = getVisibleTypes();
        if (visibleTypes.indexOf(state.activeType) === -1) {
            state.activeType = visibleTypes[0] || "";
        }

        return state.activeType;
    }

    function getVisibleTypes() {
        return state.availableTypes.length ? state.availableTypes : [];
    }

    function getPageSize() {
        var value = state.config && Number(state.config.pageSize);
        if (!Number.isFinite(value)) {
            return 100;
        }

        return Math.max(1, Math.min(100, Math.floor(value)));
    }

    function ensureRoot() {
        if (!state.resultsElement) {
            return null;
        }

        if (!state.root || !state.root.isConnected) {
            var nativeInput = getSearchTextInput();
            var nativeInputWasFocused = document.activeElement === nativeInput;
            state.root = document.createElement("div");
            state.root.className = ROOT_CLASS;
            if (!state.stylesheetReady) {
                state.root.style.visibility = "hidden";
            }
            state.resultsElement.insertAdjacentElement("afterend", state.root);
            state.root.appendChild(createSearchBar());

            var tabbar = document.createElement("div");
            tabbar.className = "better-jellyfin-search-tabbar";
            state.root.appendChild(tabbar);

            var tabs = document.createElement("div");
            tabs.className = "better-jellyfin-search-tabs";
            tabs.setAttribute("role", "tablist");
            tabs.setAttribute("aria-label", "Search result category");
            tabbar.appendChild(tabs);
            tabbar.appendChild(createSortControl());

            var content = document.createElement("div");
            content.className = "better-jellyfin-search-content";
            state.root.appendChild(content);

            if (nativeInputWasFocused) {
                var pluginInput = state.root.querySelector(".better-jellyfin-search-search-input");
                if (pluginInput) {
                    pluginInput.focus({
                        preventScroll: true
                    });
                    if (typeof pluginInput.setSelectionRange === "function") {
                        pluginInput.setSelectionRange(pluginInput.value.length, pluginInput.value.length);
                    }
                }
            }
        }

        hideOriginalResults(state.searchPage);
        hideOriginalSearchInput();
        return state.root;
    }

    function removeRoot() {
        state.lastRouteKey = "";
        restoreHiddenElements();
        if (state.resultsElement) {
            state.resultsElement.style.display = "";
        }

        if (state.root) {
            state.root.remove();
            state.root = null;
        }
    }

    function setStatus(message, className) {
        var root = ensureRoot();
        if (!root) {
            return;
        }

        renderShell(root);
        var content = getContentElement(root);
        content.innerHTML = "";
        var status = document.createElement("div");
        status.className = className || "better-jellyfin-search-status";
        status.textContent = message;
        content.appendChild(status);
    }

    function getItemImageUrl(item) {
        var client = getApiClient();
        if (!item || !client) {
            return "";
        }

        var itemId = item.Id || item.ItemId;
        var imageTag = item.ImageTags && (item.ImageTags.Primary || item.ImageTags.Thumb)
            || item.PrimaryImageTag
            || item.ThumbImageTag;
        var imageType = item.ImageTags && item.ImageTags.Primary || item.PrimaryImageTag ? "Primary" : "Thumb";
        if (item.ThumbImageItemId && item.ThumbImageTag && !item.PrimaryImageTag) {
            itemId = item.ThumbImageItemId;
            imageTag = item.ThumbImageTag;
            imageType = "Thumb";
        }

        if (!imageTag && item.SeriesPrimaryImageTag) {
            imageTag = item.SeriesPrimaryImageTag;
            imageType = "Primary";
        }

        if (!itemId || !imageTag) {
            return "";
        }

        if (typeof client.getScaledImageUrl === "function") {
            return client.getScaledImageUrl(itemId, {
                type: imageType,
                fillWidth: 422,
                fillHeight: 238,
                quality: 96,
                tag: imageTag
            });
        }

        return "/Items/" + encodeURIComponent(itemId) + "/Images/" + imageType
            + "?fillHeight=238&fillWidth=422&quality=96&tag=" + encodeURIComponent(imageTag);
    }

    function openItem(item) {
        var itemId = item && (item.Id || item.ItemId);
        if (!itemId) {
            return;
        }

        saveScrollState();
        state.lastRouteKey = "";

        if (window.Emby && window.Emby.Page && typeof window.Emby.Page.showItem === "function") {
            window.Emby.Page.showItem(itemId);
            return;
        }

        if (window.Dashboard && typeof window.Dashboard.navigate === "function") {
            window.Dashboard.navigate("itemdetails.html?id=" + encodeURIComponent(itemId));
            return;
        }

        window.location.href = "/web/index.html#!/details?id=" + encodeURIComponent(itemId);
    }

    function getCurrentDeviceId() {
        var client = getApiClient();
        var credentials = getStoredCredentials();

        if (client && typeof client.deviceId === "function") {
            return client.deviceId();
        }

        return client && (client.deviceId || client._deviceId)
            || credentials && (credentials.DeviceId || credentials.deviceId)
            || "";
    }

    function selectCurrentSession(sessions) {
        var userId = getCurrentUserId();
        var deviceId = getCurrentDeviceId();
        var candidates = Array.isArray(sessions) ? sessions : [];

        if (deviceId) {
            var deviceMatch = candidates.find(function (session) {
                return session && session.DeviceId === deviceId;
            });
            if (deviceMatch) {
                return deviceMatch;
            }
        }

        var userSessions = userId
            ? candidates.filter(function (session) {
                return session && session.UserId === userId;
            })
            : candidates;

        return userSessions.find(function (session) {
            return session && session.SupportsRemoteControl && session.SupportsMediaControl;
        }) || userSessions.find(function (session) {
            return session && session.SupportsMediaControl;
        }) || userSessions.find(function (session) {
            return session && session.SupportsRemoteControl;
        }) || userSessions.find(function (session) {
            return session && /Jellyfin Web|Web/i.test(session.Client || "");
        }) || userSessions[0] || null;
    }

    function playItem(item) {
        var itemId = item && (item.Id || item.ItemId);
        if (!itemId) {
            return Promise.resolve(false);
        }

        saveScrollState();
        state.lastRouteKey = "";

        return apiGetJson("Sessions", {
            ControllableByUserId: getCurrentUserId()
        }).then(function (sessions) {
            var session = selectCurrentSession(sessions);
            if (!session || !session.Id) {
                throw new Error("No controllable Jellyfin Web session was found");
            }

            return apiPost("Sessions/" + encodeURIComponent(session.Id) + "/Playing", {
                ControllingUserId: getCurrentUserId(),
                PlayCommand: "PlayNow",
                ItemIds: [itemId],
                StartPositionTicks: 0
            }, {
                PlayCommand: "PlayNow",
                ItemIds: itemId,
                StartPositionTicks: 0
            });
        }).then(function () {
            return true;
        }).catch(function (error) {
            console.warn("[Better Jellyfin Search] Play command failed", error);
            return false;
        });
    }

    function setJellyfinActionData(element, item) {
        var itemId = item && (item.Id || item.ItemId);
        if (!itemId) {
            return;
        }

        element.setAttribute("data-id", itemId);
        element.setAttribute("data-itemid", itemId);
        element.setAttribute("data-serverid", item.ServerId || window.ApiClient && typeof window.ApiClient.serverId === "function" && window.ApiClient.serverId() || "");
        element.setAttribute("data-type", item.Type || "");
        element.setAttribute("data-mediatype", item.MediaType || "");
        element.setAttribute("data-isfolder", item.IsFolder ? "true" : "false");
    }

    function isPlayButtonEvent(event) {
        return event.target && typeof event.target.closest === "function" && event.target.closest(".better-jellyfin-search-play");
    }

    function itemMeta(item) {
        var parts = [];
        if (item.ProductionYear) {
            parts.push(String(item.ProductionYear));
        }

        if ((item.SeriesName || item.Series) && item.Type === "Episode") {
            parts.push(item.SeriesName || item.Series);
        }

        if (item.AlbumArtist || item.Artists && item.Artists.length) {
            parts.push(item.AlbumArtist || item.Artists.join(", "));
        }

        return parts.join(" / ");
    }

    function padEpisodeNumber(value) {
        var number = Number(value);
        if (!Number.isFinite(number) || number <= 0) {
            return "";
        }

        return number < 10 ? "0" + number : String(number);
    }

    function getEpisodeCode(item) {
        var season = padEpisodeNumber(item.ParentIndexNumber);
        var episode = padEpisodeNumber(item.IndexNumber);

        if (season && episode) {
            return "S" + season + "E" + episode;
        }

        if (season) {
            return "S" + season;
        }

        return episode ? "E" + episode : "";
    }

    function appendEpisodeTitle(card, item) {
        var seriesName = item.SeriesName || item.Series || "";
        var episodeCode = getEpisodeCode(item);
        var episodeName = item.Name || "Untitled";

        var series = document.createElement("span");
        series.className = "better-jellyfin-search-name better-jellyfin-search-episode-series";
        series.textContent = seriesName || episodeName;
        card.appendChild(series);

        if (!seriesName) {
            return;
        }

        var episode = document.createElement("span");
        episode.className = "better-jellyfin-search-episode-title";
        episode.textContent = episodeCode ? episodeCode + " - " + episodeName : episodeName;
        card.appendChild(episode);
    }

    function getSortValue(item, sortBy) {
        if (!item) {
            return null;
        }

        if (sortBy === "SortName") {
            return item.SortName || item.Name || "";
        }

        if (sortBy === "DateCreated") {
            return item.DateCreated || null;
        }

        if (sortBy === "DatePlayed") {
            return item.UserData && item.UserData.LastPlayedDate || item.LastPlayedDate || null;
        }

        if (sortBy === "Runtime") {
            return item.RunTimeTicks || null;
        }

        if (sortBy === "PlayCount") {
            if (item.UserData && Number.isFinite(item.UserData.PlayCount)) {
                return item.UserData.PlayCount;
            }

            return Number.isFinite(item.PlayCount) ? item.PlayCount : null;
        }

        return item.Name || "";
    }

    function normalizeComparable(value, sortBy) {
        if (value === null || value === undefined || value === "") {
            return null;
        }

        if (sortBy === "SortName") {
            return String(value);
        }

        if (sortBy === "DateCreated" || sortBy === "DatePlayed") {
            var timestamp = typeof value === "number" ? value : Date.parse(value);
            return Number.isFinite(timestamp) ? timestamp : null;
        }

        var numericValue = Number(value);
        return Number.isFinite(numericValue) ? numericValue : null;
    }

    function parseSplitPartName(value) {
        var text = String(value || "");
        var match = /^(.*)_(\d+)$/.exec(text);
        if (!match) {
            return {
                base: text,
                part: null,
                text: text
            };
        }

        return {
            base: match[1],
            part: Number(match[2]),
            text: text
        };
    }

    function compareNames(leftValue, rightValue, direction) {
        var leftName = parseSplitPartName(leftValue);
        var rightName = parseSplitPartName(rightValue);
        var baseComparison = NAME_COLLATOR.compare(leftName.base, rightName.base);
        if (baseComparison !== 0) {
            return baseComparison * direction;
        }

        if (leftName.part !== null || rightName.part !== null) {
            if (leftName.part === null) {
                return -1;
            }

            if (rightName.part === null) {
                return 1;
            }

            if (leftName.part !== rightName.part) {
                return leftName.part - rightName.part;
            }
        }

        return NAME_COLLATOR.compare(leftName.text, rightName.text) * direction;
    }

    function compareItems(left, right) {
        var sortBy = state.sortBy;
        var direction = state.sortOrder === "Ascending" ? 1 : -1;
        var leftValue = normalizeComparable(getSortValue(left, sortBy), sortBy);
        var rightValue = normalizeComparable(getSortValue(right, sortBy), sortBy);

        if (leftValue === null && rightValue === null) {
            return compareNames(left && (left.SortName || left.Name) || "", right && (right.SortName || right.Name) || "", direction);
        }

        if (leftValue === null) {
            return 1;
        }

        if (rightValue === null) {
            return -1;
        }

        if (sortBy === "SortName") {
            return compareNames(leftValue, rightValue, direction);
        }

        if (leftValue === rightValue) {
            return compareNames(left && (left.SortName || left.Name) || "", right && (right.SortName || right.Name) || "", direction);
        }

        return leftValue > rightValue ? direction : -direction;
    }

    function sortItems(items) {
        return items.slice().sort(compareItems);
    }

    function getPageItems(items, startIndex) {
        var pageSize = getPageSize();
        return items.slice(startIndex, startIndex + pageSize);
    }

    function createCard(item) {
        var card = document.createElement("div");
        card.className = "better-jellyfin-search-card card-hoverable";
        card.setAttribute("role", "button");
        setJellyfinActionData(card, item);
        card.tabIndex = 0;
        card.addEventListener("click", function (event) {
            if (isPlayButtonEvent(event)) {
                return;
            }

            openItem(item);
        });
        card.addEventListener("keydown", function (event) {
            if (isPlayButtonEvent(event)) {
                return;
            }

            if (event.key !== "Enter" && event.key !== " ") {
                return;
            }

            event.preventDefault();
            openItem(item);
        });

        var cardBox = document.createElement("div");
        cardBox.className = "better-jellyfin-search-poster cardBox visualCardBox";
        setJellyfinActionData(cardBox, item);

        var scalable = document.createElement("div");
        scalable.className = "better-jellyfin-search-scalable cardScalable";
        setJellyfinActionData(scalable, item);
        cardBox.appendChild(scalable);

        var padder = document.createElement("div");
        padder.className = "cardPadder";
        scalable.appendChild(padder);

        var imageAction = document.createElement("span");
        imageAction.className = "better-jellyfin-search-image-action cardContent itemAction coveredImage cardImageContainer";
        imageAction.setAttribute("data-action", "link");
        setJellyfinActionData(imageAction, item);
        scalable.appendChild(imageAction);

        var imageUrl = getItemImageUrl(item);
        if (imageUrl) {
            var image = document.createElement("img");
            image.loading = "lazy";
            image.alt = "";
            image.src = imageUrl;
            imageAction.appendChild(image);
        } else {
            var placeholder = document.createElement("span");
            placeholder.className = "better-jellyfin-search-placeholder";
            placeholder.textContent = (item.Name || "?").slice(0, 1).toUpperCase();
            imageAction.appendChild(placeholder);
        }

        var overlay = document.createElement("div");
        overlay.className = "cardOverlayContainer";
        scalable.appendChild(overlay);

        var playButton = document.createElement("button");
        playButton.type = "button";
        playButton.className = "better-jellyfin-search-play cardOverlayButton cardOverlayButton-hover itemAction paper-icon-button-light cardOverlayFab-primary";
        playButton.setAttribute("data-action", "resume");
        setJellyfinActionData(playButton, item);
        playButton.setAttribute("title", "Play");
        playButton.setAttribute("aria-label", "Play " + (item.Name || "item"));
        playButton.addEventListener("click", function (event) {
            event.preventDefault();
            event.stopPropagation();
            playButton.blur();
            playItem(item);
        });
        var playIcon = document.createElement("span");
        playIcon.className = "material-icons";
        playIcon.setAttribute("aria-hidden", "true");
        playIcon.textContent = "play_arrow";
        playButton.appendChild(playIcon);
        overlay.appendChild(playButton);

        card.appendChild(cardBox);

        if (item.Type === "Episode") {
            appendEpisodeTitle(card, item);
            return card;
        }

        var name = document.createElement("span");
        name.className = "better-jellyfin-search-name";
        name.textContent = item.Name || "Untitled";
        card.appendChild(name);

        var metaText = itemMeta(item);
        if (metaText) {
            var meta = document.createElement("span");
            meta.className = "better-jellyfin-search-meta";
            meta.textContent = metaText;
            card.appendChild(meta);
        }

        return card;
    }

    function syncNativeSearchInput(value) {
        var input = getSearchTextInput();
        updateSearchRoute(value, state.activeType, 0);

        if (!input || input.value === value) {
            return;
        }

        input.value = value;
        input.dispatchEvent(new Event("input", {
            bubbles: true
        }));
    }

    function createSearchBar() {
        var form = document.createElement("form");
        form.className = "better-jellyfin-search-search";
        form.addEventListener("submit", function (event) {
            event.preventDefault();
            var input = form.querySelector(".better-jellyfin-search-search-input");
            var value = input ? input.value.trim() : "";
            syncNativeSearchInput(value);
            scheduleSearch();
        });

        var icon = document.createElement("span");
        icon.className = "better-jellyfin-search-search-icon";
        icon.setAttribute("aria-hidden", "true");

        var input = document.createElement("input");
        input.className = "better-jellyfin-search-search-input";
        input.type = "search";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.value = state.query || getSearchTerm();
        input.placeholder = "Search";
        input.setAttribute("aria-label", "Search");
        input.addEventListener("input", function () {
            syncNativeSearchInput(input.value);
            scheduleSearch();
        });

        form.append(icon, input);
        return form;
    }

    function createTabs() {
        var tabs = document.createElement("div");
        tabs.className = "better-jellyfin-search-tabs";
        tabs.setAttribute("role", "tablist");
        tabs.setAttribute("aria-label", "Search result category");

        fillTabs(tabs);
        return tabs;
    }

    function fillTabs(tabs) {
        var previousCounts = getRenderedTabCounts(tabs);
        tabs.innerHTML = "";
        var activeType = getActiveType();
        getVisibleTypes().forEach(function (type) {
            var total = state.typeCounts[type] || previousCounts[type] || 0;
            if (state.results
                && state.results.activeType === type
                && !state.results.loading
                && Number.isFinite(state.results.total)) {
                total = state.results.total;
            }

            var tab = document.createElement("button");
            tab.type = "button";
            tab.className = "better-jellyfin-search-tab" + (type === activeType ? " is-active" : "");
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-selected", type === activeType ? "true" : "false");
            tab.textContent = (TYPE_LABELS[type] || type) + " (" + formatNumber(total) + ")";
            tab.addEventListener("click", function () {
                if (state.activeType === type) {
                    return;
                }

                state.activeType = type;
                state.requestId += 1;
                loadResults(0);
            });
            tabs.appendChild(tab);
        });
    }

    function getRenderedTabCounts(tabs) {
        var counts = {};
        Array.prototype.slice.call(tabs.querySelectorAll(".better-jellyfin-search-tab")).forEach(function (tab) {
            var text = tab.textContent || "";
            var match = text.match(/^(.+?)\s+\(([\d,.\s]+)\)$/);
            if (!match) {
                return;
            }

            var label = match[1].trim();
            var type = Object.keys(TYPE_LABELS).find(function (candidate) {
                return TYPE_LABELS[candidate] === label;
            });
            var total = Number(match[2].replace(/[^\d]/g, ""));
            if (type && Number.isFinite(total)) {
                counts[type] = total;
            }
        });

        return counts;
    }

    function createSortControl() {
        var container = document.createElement("div");
        container.className = "better-jellyfin-search-sort";

        var divider = document.createElement("span");
        divider.className = "better-jellyfin-search-sort-divider";
        divider.setAttribute("aria-hidden", "true");

        var button = document.createElement("button");
        button.type = "button";
        button.className = "better-jellyfin-search-sort-button";
        button.setAttribute("aria-haspopup", "true");
        button.setAttribute("aria-expanded", "false");
        button.title = "Sort";
        button.innerHTML = "<span></span><span></span><span></span>";
        button.addEventListener("click", function () {
            state.sortMenuOpen = !state.sortMenuOpen;
            renderSortControl();
        });

        var menu = document.createElement("div");
        menu.className = "better-jellyfin-search-sort-menu";
        menu.hidden = true;

        container.append(divider, button, menu);
        return container;
    }

    function renderSortControl() {
        if (!state.root) {
            return;
        }

        var sort = state.root.querySelector(".better-jellyfin-search-sort");
        if (!sort) {
            return;
        }

        var button = sort.querySelector(".better-jellyfin-search-sort-button");
        var menu = sort.querySelector(".better-jellyfin-search-sort-menu");
        if (!button || !menu) {
            return;
        }

        button.setAttribute("aria-expanded", state.sortMenuOpen ? "true" : "false");
        button.title = "Sort: " + getSortLabel(state.sortBy) + ", " + state.sortOrder;
        menu.innerHTML = "";
        menu.hidden = !state.sortMenuOpen;

        if (!state.sortMenuOpen) {
            return;
        }

        var label = document.createElement("label");
        label.className = "better-jellyfin-search-sort-label";
        label.textContent = "Sort by";

        var select = document.createElement("select");
        select.className = "better-jellyfin-search-sort-select";
        SORT_OPTIONS.forEach(function (option) {
            var item = document.createElement("option");
            item.value = option.value;
            item.textContent = option.label;
            item.selected = option.value === state.sortBy;
            select.appendChild(item);
        });
        select.addEventListener("change", function () {
            applySort(select.value, state.sortOrder);
        });

        var ascending = createSortRadio("Ascending");
        var descending = createSortRadio("Descending");

        menu.append(label, select, ascending, descending);
    }

    function closeSortMenu() {
        if (!state.sortMenuOpen) {
            return;
        }

        state.sortMenuOpen = false;
        renderSortControl();
    }

    function bindSortMenuDismiss() {
        if (window.__betterJellyfinSearchSortDismissBound) {
            return;
        }

        window.__betterJellyfinSearchSortDismissBound = true;
        document.addEventListener("pointerdown", function (event) {
            if (!state.sortMenuOpen || !state.root) {
                return;
            }

            var sort = state.root.querySelector(".better-jellyfin-search-sort");
            if (sort && sort.contains(event.target)) {
                return;
            }

            closeSortMenu();
        });
        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape") {
                closeSortMenu();
            }
        });
    }

    function createSortRadio(value) {
        var label = document.createElement("label");
        label.className = "better-jellyfin-search-sort-radio";

        var input = document.createElement("input");
        input.type = "radio";
        input.name = "better-jellyfin-search-sort-order";
        input.value = value;
        input.checked = state.sortOrder === value;
        input.addEventListener("change", function () {
            if (input.checked) {
                applySort(state.sortBy, value);
            }
        });

        var text = document.createElement("span");
        text.textContent = value === "Ascending" ? "Ascending" : "Descending";

        label.append(input, text);
        return label;
    }

    function applySort(sortBy, sortOrder) {
        var scrollY = window.scrollY || 0;
        state.sortBy = normalizeSortBy(sortBy);
        state.sortOrder = normalizeSortOrder(sortOrder);
        storeSort(state.sortBy, state.sortOrder);
        updateSearchRoute(state.query, state.activeType, 0);
        state.sortMenuOpen = false;
        state.requestId += 1;
        loadResults(0, scrollY);
    }

    function formatNumber(value) {
        return new Intl.NumberFormat().format(value || 0);
    }

    function pageToStartIndex(pageNumber) {
        return (pageNumber - 1) * getPageSize();
    }

    function loadPageResults(startIndex) {
        return loadResults(startIndex, undefined, true);
    }

    function createPageButton(pageNumber, currentPage, totalPages) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "better-jellyfin-search-page-button";
        button.textContent = String(pageNumber);
        button.setAttribute("aria-label", "Page " + pageNumber);
        if (pageNumber === currentPage) {
            button.classList.add("is-active");
            button.setAttribute("aria-current", "page");
        }

        if (pageNumber === currentPage) {
            button.addEventListener("click", function () {
                replacePageButtonWithInput(button, pageNumber, totalPages);
            });
        } else {
            button.addEventListener("click", function () {
                loadPageResults(pageToStartIndex(pageNumber));
            });
        }

        return button;
    }

    function createPageEllipsis() {
        var ellipsis = document.createElement("span");
        ellipsis.className = "better-jellyfin-search-page-ellipsis";
        ellipsis.textContent = "...";
        ellipsis.setAttribute("aria-hidden", "true");
        return ellipsis;
    }

    function replacePageButtonWithInput(button, pageNumber, totalPages) {
        var scrollY = window.scrollY || 0;
        var input = document.createElement("input");
        input.className = "better-jellyfin-search-page-input";
        input.type = "number";
        input.min = "1";
        input.max = String(totalPages);
        input.inputMode = "numeric";
        input.value = String(pageNumber);
        input.setAttribute("aria-label", "Page number");
        var committed = false;

        function restoreButton() {
            input.replaceWith(createPageButton(pageNumber, pageNumber, totalPages));
            restoreWindowScroll(scrollY);
        }

        function commit() {
            if (committed) {
                return;
            }

            committed = true;
            var value = Number(input.value);
            if (Number.isFinite(value)) {
                var targetPage = Math.min(totalPages, Math.max(1, Math.floor(value)));
                loadPageResults(pageToStartIndex(targetPage));
                return;
            }

            restoreButton();
        }

        input.addEventListener("keydown", function (event) {
            if (event.key === "Enter") {
                event.preventDefault();
                commit();
            }

            if (event.key === "Escape") {
                event.preventDefault();
                committed = true;
                restoreButton();
            }
        });
        input.addEventListener("blur", commit);
        button.replaceWith(input);
        input.focus({
            preventScroll: true
        });
        input.select();
        restoreWindowScroll(scrollY);
    }

    function addPageGroup(pageSet, start, end, totalPages) {
        for (var page = start; page <= end; page += 1) {
            if (page >= 1 && page <= totalPages) {
                pageSet.add(page);
            }
        }
    }

    function createPager(resultState, position) {
        var total = resultState.total || 0;
        var pageSize = getPageSize();
        var totalPages = Math.ceil(total / pageSize);
        var currentPage = Math.floor(resultState.startIndex / pageSize) + 1;
        var pager = document.createElement("div");
        pager.className = "better-jellyfin-search-pager";
        if (position) {
            pager.classList.add("better-jellyfin-search-pager-" + position);
        }

        var first = document.createElement("button");
        first.type = "button";
        first.className = "better-jellyfin-search-page-button";
        first.setAttribute("aria-label", "First page");
        first.textContent = "<<";
        first.disabled = currentPage <= 1;
        first.addEventListener("click", function () {
            loadPageResults(0);
        });

        var previous = document.createElement("button");
        previous.type = "button";
        previous.className = "better-jellyfin-search-page-button";
        previous.setAttribute("aria-label", "Previous page");
        previous.textContent = "<";
        previous.disabled = currentPage <= 1;
        previous.addEventListener("click", function () {
            loadPageResults(pageToStartIndex(Math.max(1, currentPage - 1)));
        });

        var next = document.createElement("button");
        next.type = "button";
        next.className = "better-jellyfin-search-page-button";
        next.setAttribute("aria-label", "Next page");
        next.textContent = ">";
        next.disabled = currentPage >= totalPages;
        next.addEventListener("click", function () {
            loadPageResults(pageToStartIndex(Math.min(totalPages, currentPage + 1)));
        });

        var last = document.createElement("button");
        last.type = "button";
        last.className = "better-jellyfin-search-page-button";
        last.setAttribute("aria-label", "Last page");
        last.textContent = ">>";
        last.disabled = currentPage >= totalPages;
        last.addEventListener("click", function () {
            loadPageResults(pageToStartIndex(totalPages));
        });

        pager.append(first, previous);

        if (totalPages <= 6) {
            for (var page = 1; page <= totalPages; page += 1) {
                pager.appendChild(createPageButton(page, currentPage, totalPages));
            }
        } else {
            var pageSet = new Set();
            addPageGroup(pageSet, 1, 3, totalPages);
            addPageGroup(pageSet, totalPages - 2, totalPages, totalPages);
            if (currentPage > 3 && currentPage < totalPages - 2) {
                pageSet.add(currentPage);
            }

            var visiblePages = Array.from(pageSet).sort(function (left, right) {
                return left - right;
            });
            visiblePages.forEach(function (pageNumber, index) {
                if (index > 0 && pageNumber - visiblePages[index - 1] > 1) {
                    pager.appendChild(createPageEllipsis());
                }

                pager.appendChild(createPageButton(pageNumber, currentPage, totalPages));
            });
        }

        pager.append(next, last);
        return pager;
    }

    function createShell() {
        var fragment = document.createDocumentFragment();
        fragment.appendChild(createSearchBar());
        fragment.appendChild(createTabs());
        return fragment;
    }

    function getTabsElement(root) {
        return root.querySelector(".better-jellyfin-search-tabs");
    }

    function getContentElement(root) {
        var content = root.querySelector(".better-jellyfin-search-content");
        if (!content) {
            content = document.createElement("div");
            content.className = "better-jellyfin-search-content";
            root.appendChild(content);
        }

        return content;
    }

    function renderShell(root) {
        var input = root.querySelector(".better-jellyfin-search-search-input");
        if (input && document.activeElement !== input) {
            input.value = state.query || getSearchTerm();
        }

        var tabbar = root.querySelector(".better-jellyfin-search-tabbar");
        if (tabbar) {
            tabbar.classList.toggle("is-visible", getVisibleTypes().length > 0);
        }

        var tabs = getTabsElement(root);
        if (tabs) {
            fillTabs(tabs);
        }

        renderSortControl();
    }

    function captureSearchFocus(root) {
        var active = document.activeElement;
        if (!root || !active || !active.classList || !active.classList.contains("better-jellyfin-search-search-input")) {
            return null;
        }

        return {
            start: active.selectionStart,
            end: active.selectionEnd
        };
    }

    function restoreSearchFocus(root, focusState) {
        if (!focusState) {
            return;
        }

        var input = root.querySelector(".better-jellyfin-search-search-input");
        if (!input) {
            return;
        }

        input.focus({
            preventScroll: true
        });

        if (typeof input.setSelectionRange === "function"
            && Number.isFinite(focusState.start)
            && Number.isFinite(focusState.end)) {
            input.setSelectionRange(focusState.start, focusState.end);
        }
    }

    function getCurrentStartIndex() {
        return state.results && Number.isFinite(state.results.startIndex)
            ? state.results.startIndex
            : getRouteParams().startIndex;
    }

    function getCurrentRouteKey() {
        return getRouteKey(state.query || getSearchTerm(), state.activeType || getRouteParams().type, getCurrentStartIndex());
    }

    function saveScrollState() {
        if (!isSearchLocation() || !state.query) {
            return;
        }

        try {
            sessionStorage.setItem(SCROLL_STORAGE_PREFIX + getCurrentRouteKey(), String(window.scrollY || 0));
        } catch (error) {
            return;
        }
    }

    function restoreScrollState() {
        if (!isSearchLocation() || !state.query) {
            return;
        }

        var key = getCurrentRouteKey();
        if (state.lastRouteKey === key) {
            return;
        }

        state.lastRouteKey = key;

        try {
            var stored = sessionStorage.getItem(SCROLL_STORAGE_PREFIX + key);
            if (stored === null) {
                return;
            }

            var scrollY = Number(stored);
            if (!Number.isFinite(scrollY)) {
                return;
            }

            window.setTimeout(function () {
                window.scrollTo({
                    top: scrollY,
                    behavior: "auto"
                });
            }, 0);
        } catch (error) {
            return;
        }
    }

    function restoreWindowScroll(scrollY) {
        if (!Number.isFinite(scrollY)) {
            return;
        }

        window.setTimeout(function () {
            window.scrollTo({
                top: scrollY,
                behavior: "auto"
            });
        }, 0);

        window.requestAnimationFrame(function () {
            window.scrollTo({
                top: scrollY,
                behavior: "auto"
            });
        });
    }

    function scrollToPageTop() {
        window.setTimeout(function () {
            window.scrollTo({
                top: 0,
                left: 0,
                behavior: "auto"
            });
        }, 0);

        window.requestAnimationFrame(function () {
            window.scrollTo({
                top: 0,
                left: 0,
                behavior: "auto"
            });
        });
    }

    function render() {
        var root = ensureRoot();
        if (!root) {
            return;
        }

        var focusState = captureSearchFocus(root);
        renderShell(root);
        restoreSearchFocus(root, focusState);
        var content = getContentElement(root);
        content.innerHTML = "";
        if (!state.query) {
            return;
        }

        var resultState = state.results;
        if (!resultState || resultState.loading) {
            var loading = document.createElement("div");
            loading.className = "better-jellyfin-search-status";
            loading.textContent = "Searching...";
            content.appendChild(loading);
            return;
        }

        if (resultState.error) {
            var error = document.createElement("div");
            error.className = "better-jellyfin-search-error";
            error.textContent = "Better Jellyfin Search could not load results.";
            content.appendChild(error);
            return;
        }

        if (state.countsLoading) {
            var counting = document.createElement("div");
            counting.className = "better-jellyfin-search-status";
            counting.textContent = "Searching...";
            content.appendChild(counting);
            return;
        }

        if (!resultState.items || !resultState.items.length) {
            var empty = document.createElement("div");
            empty.className = "better-jellyfin-search-empty";
            empty.textContent = "No results found.";
            content.appendChild(empty);
            return;
        }

        var grid = document.createElement("div");
        grid.className = "better-jellyfin-search-grid";
        resultState.items.forEach(function (item) {
            grid.appendChild(createCard(item));
        });

        content.appendChild(createPager(resultState, "top"));
        content.appendChild(grid);
        content.appendChild(createPager(resultState, "bottom"));
        restoreScrollState();
    }

    function normalizeItems(result) {
        if (Array.isArray(result)) {
            return {
                items: result,
                total: result.length
            };
        }

        var items = [];
        if (result && Array.isArray(result.Items)) {
            items = result.Items;
        } else if (result && Array.isArray(result.SearchHints)) {
            items = result.SearchHints;
        }

        return {
            items: items,
            total: result && Number.isFinite(result.TotalRecordCount) ? result.TotalRecordCount : items.length
        };
    }

    function normalizeSearchHint(hint) {
        if (!hint) {
            return hint;
        }

        var itemId = hint.Id || hint.ItemId;
        return Object.assign({}, hint, {
            Id: itemId,
            ItemId: itemId,
            SeriesName: hint.SeriesName || hint.Series || ""
        });
    }

    function normalizeSearchHints(result) {
        var normalized = normalizeItems(result);
        normalized.items = normalized.items.map(normalizeSearchHint);
        return normalized;
    }

    function apiUrl(path, options) {
        var client = getApiClient();
        if (client && typeof client.getUrl === "function") {
            return client.getUrl(path, options);
        }

        var query = new URLSearchParams();
        Object.keys(options).forEach(function (key) {
            if (options[key] !== undefined && options[key] !== null && options[key] !== "") {
                query.set(key, options[key]);
            }
        });

        return "/" + path.replace(/^\/+/, "") + "?" + query.toString();
    }

    function apiGetJson(path, options) {
        var client = getApiClient();
        var url = apiUrl(path, options);
        var credentials = getStoredCredentials();
        var token = credentials && (credentials.AccessToken || credentials.accessToken);
        var headers = {
            Accept: "application/json"
        };
        if (token) {
            headers.Authorization = "MediaBrowser Token=\"" + token + "\"";
            headers["X-Emby-Token"] = token;
        }

        if (client && typeof client.getJSON === "function") {
            return client.getJSON(url);
        }

        if (client && typeof client.ajax === "function") {
            return client.ajax({
                type: "GET",
                url: url
            });
        }

        return fetch(url, {
            credentials: "same-origin",
            headers: headers
        }).then(function (response) {
            if (!response.ok) {
                throw new Error("Search request failed");
            }

            return response.json();
        });
    }

    function apiPost(path, options, body) {
        var client = getApiClient();
        var url = apiUrl(path, options || {});
        var credentials = getStoredCredentials();
        var token = credentials && (credentials.AccessToken || credentials.accessToken);
        var headers = {};
        var data = body === undefined ? undefined : JSON.stringify(body);
        if (token) {
            headers.Authorization = "MediaBrowser Token=\"" + token + "\"";
            headers["X-Emby-Token"] = token;
        }

        if (client && typeof client.ajax === "function") {
            return client.ajax({
                type: "POST",
                url: url,
                data: data,
                contentType: "application/json"
            });
        }

        return fetch(url, {
            method: "POST",
            credentials: "same-origin",
            headers: Object.assign(data ? {
                "Content-Type": "application/json"
            } : {}, headers),
            body: data
        }).then(function (response) {
            if (!response.ok) {
                throw new Error("Remote playback command failed");
            }

            return response;
        });
    }

    function getCurrentUserId() {
        var client = getApiClient();
        var credentials = getStoredCredentials();
        return client && typeof client.getCurrentUserId === "function"
            ? client.getCurrentUserId()
            : credentials && (credentials.UserId || credentials.userId);
    }

    function needsEpisodeDetails(item) {
        return item
            && item.Type === "Episode"
            && item.Id
            && (!item.SeriesName || !item.ParentIndexNumber || !item.IndexNumber);
    }

    function queryItemDetails(item) {
        var userId = getCurrentUserId();
        if (!userId || !item || !item.Id) {
            return Promise.resolve(item);
        }

        return apiGetJson("Users/" + encodeURIComponent(userId) + "/Items/" + encodeURIComponent(item.Id), {
            Fields: "PrimaryImageAspectRatio,SortName,DateCreated,MediaSourceCount,SeriesName,ParentIndexNumber,IndexNumber"
        }).then(function (details) {
            return Object.assign({}, item, details || {});
        }).catch(function () {
            return item;
        });
    }

    function enrichVisibleEpisodes(requestId) {
        if (!state.results || state.results.activeType !== "Episode" || !Array.isArray(state.results.items)) {
            return Promise.resolve();
        }

        var items = state.results.items;
        if (!items.some(needsEpisodeDetails)) {
            return Promise.resolve();
        }

        return Promise.all(items.map(function (item) {
            return needsEpisodeDetails(item) ? queryItemDetails(item) : Promise.resolve(item);
        })).then(function (enrichedItems) {
            if (requestId !== state.requestId || !state.results || state.results.activeType !== "Episode") {
                return;
            }

            state.results.items = enrichedItems;
        });
    }

    function queryItems(type, startIndex, limit) {
        var client = getApiClient();
        var pageSize = limit || getPageSize();
        var userId = getCurrentUserId();

        if (type === "Episode") {
            return apiGetJson("Search/Hints", {
                SearchTerm: state.query,
                IncludeItemTypes: type,
                Limit: pageSize,
                StartIndex: startIndex,
                UserId: userId,
                IncludeMedia: true,
                IncludePeople: false,
                IncludeGenres: false,
                IncludeStudios: false,
                IncludeArtists: false
            });
        }

        var clientOptions = {
            Recursive: true,
            SearchTerm: state.query,
            IncludeItemTypes: type,
            Limit: pageSize,
            StartIndex: startIndex,
            EnableTotalRecordCount: true,
            EnableUserData: true,
            ImageTypeLimit: 1,
            Fields: "PrimaryImageAspectRatio,SortName,DateCreated,MediaSourceCount,SeriesName,ParentIndexNumber,IndexNumber"
        };

        if (client && typeof client.getItems === "function") {
            return client.getItems(userId, clientOptions);
        }

        return apiGetJson("Users/" + encodeURIComponent(userId) + "/Items", clientOptions);
    }

    function queryAllItems(limit) {
        var client = getApiClient();
        var userId = getCurrentUserId();
        if (state.activeType === "Episode") {
            return apiGetJson("Search/Hints", {
                SearchTerm: state.query,
                IncludeItemTypes: "Episode",
                Limit: limit,
                StartIndex: 0,
                UserId: userId,
                IncludeMedia: true,
                IncludePeople: false,
                IncludeGenres: false,
                IncludeStudios: false,
                IncludeArtists: false
            });
        }

        var clientOptions = {
            Recursive: true,
            SearchTerm: state.query,
            Limit: limit,
            StartIndex: 0,
            EnableTotalRecordCount: true,
            EnableUserData: true,
            ImageTypeLimit: 1,
            Fields: "PrimaryImageAspectRatio,SortName,DateCreated,MediaSourceCount,SeriesName,ParentIndexNumber,IndexNumber"
        };

        if (client && typeof client.getItems === "function") {
            return client.getItems(userId, clientOptions);
        }

        return apiGetJson("Users/" + encodeURIComponent(userId) + "/Items", clientOptions);
    }

    function loadSection(type, startIndex) {
        var requestId = state.requestId;
        state.sections[type] = Object.assign({}, state.sections[type], {
            loading: true,
            startIndex: startIndex
        });
        render();

        return queryItems(type, startIndex)
            .then(type === "Episode" ? normalizeSearchHints : normalizeItems)
            .then(function (result) {
                if (requestId !== state.requestId) {
                    return;
                }

                state.sections[type] = {
                    loading: false,
                    startIndex: startIndex,
                    items: result.items,
                    total: result.total
                };
                render();
            })
            .catch(function (error) {
                if (requestId !== state.requestId) {
                    return;
                }

                state.sections[type] = {
                    loading: false,
                    startIndex: startIndex,
                    items: [],
                    total: 0,
                    error: error
                };
                render();
            });
    }

    function fetchAllItems(type) {
        var allItems = [];

        function fetchBatch(startIndex) {
            return queryItems(type, startIndex, CLIENT_SORT_BATCH_SIZE)
                .then(type === "Episode" ? normalizeSearchHints : normalizeItems)
                .then(function (result) {
                    var fetchedCount = result.items.length;
                    var items = result.items.filter(function (item) {
                        return !item || getEnabledTypes().indexOf(item.Type) !== -1;
                    });
                    allItems = allItems.concat(items);

                    var total = result.total || allItems.length;
                    if (!fetchedCount || startIndex + fetchedCount >= total) {
                        return {
                            items: allItems,
                            total: Math.max(total, allItems.length)
                        };
                    }

                    return fetchBatch(startIndex + fetchedCount);
                });
        }

        return fetchBatch(0);
    }

    function setResultsFromAllItems(activeType, startIndex, allItems) {
        var sortedItems = sortItems(allItems);
        var safeStartIndex = Math.min(Math.max(startIndex || 0, 0), Math.max(sortedItems.length - 1, 0));
        safeStartIndex -= safeStartIndex % getPageSize();

        state.results = {
            loading: false,
            activeType: activeType,
            query: state.query,
            startIndex: safeStartIndex,
            items: getPageItems(sortedItems, safeStartIndex),
            allItems: allItems,
            total: sortedItems.length
        };
        state.typeCounts[activeType] = state.results.total;
    }

    function loadResults(startIndex, preserveScrollY, scrollToTop) {
        var requestId = state.requestId;
        var activeType = getActiveType();
        if (!activeType) {
            state.results = {
                loading: false,
                startIndex: 0,
                items: [],
                total: 0
            };
            render();
            return Promise.resolve();
        }

        updateSearchRoute(state.query, activeType, startIndex);
        if (state.results
            && state.results.activeType === activeType
            && state.results.query === state.query
            && Array.isArray(state.results.allItems)) {
            setResultsFromAllItems(activeType, startIndex, state.results.allItems);
            return enrichVisibleEpisodes(requestId).then(function () {
                render();
                if (scrollToTop) {
                    scrollToPageTop();
                } else {
                    restoreWindowScroll(preserveScrollY);
                }
            });
        }

        state.results = {
            loading: true,
            activeType: activeType,
            query: state.query,
            startIndex: startIndex,
            items: [],
            total: state.typeCounts[activeType] || 0
        };
        render();
        if (scrollToTop) {
            scrollToPageTop();
        }

        return fetchAllItems(activeType)
            .then(function (result) {
                if (requestId !== state.requestId) {
                    return;
                }

                setResultsFromAllItems(activeType, startIndex, result.items);
                enrichVisibleEpisodes(requestId).then(function () {
                    render();
                    if (scrollToTop) {
                        scrollToPageTop();
                    } else {
                        restoreWindowScroll(preserveScrollY);
                    }
                });
            })
            .catch(function (error) {
                if (requestId !== state.requestId) {
                    return;
                }

                state.results = {
                    loading: false,
                    startIndex: startIndex,
                    items: [],
                    total: 0,
                    error: error
                };
                render();
            });
    }

    function loadAvailableTypes() {
        var requestId = state.requestId;
        var enabledTypes = sortTypes(getEnabledTypes().slice());
        state.countsLoading = true;
        render();

        function queryTypeCount(type) {
            if (type === "Episode") {
                return fetchAllItems(type)
                    .then(function (result) {
                        return result.items.length || result.total || 0;
                    });
            }

            return queryItems(type, 0, 1)
                .then(normalizeItems)
                .then(function (result) {
                    return result.total || 0;
                });
        }

        return Promise.all(enabledTypes.map(function (type) {
            return queryTypeCount(type)
                .then(function (total) {
                    return {
                        type: type,
                        total: total
                    };
                })
                .catch(function () {
                    return {
                        type: type,
                        total: 0
                    };
                });
        })).then(function (counts) {
            if (requestId !== state.requestId) {
                return;
            }

            state.countsLoading = false;
            state.typeCounts = {};
            state.availableTypes = counts.filter(function (count) {
                state.typeCounts[count.type] = count.total;
                return count.total > 0;
            }).map(function (count) {
                return count.type;
            });

            var routeType = getRouteParams().type;
            if (routeType && state.availableTypes.indexOf(routeType) !== -1) {
                state.activeType = routeType;
            } else if (state.availableTypes.indexOf(state.activeType) === -1) {
                state.activeType = state.availableTypes[0] || "";
            }
        }).catch(function () {
            if (requestId !== state.requestId) {
                return;
            }

            state.countsLoading = false;
            state.availableTypes = [];
            state.typeCounts = {};
        });
    }

    function sortTypes(types) {
        return types.sort(function (left, right) {
            var leftIndex = TYPE_ORDER.indexOf(left);
            var rightIndex = TYPE_ORDER.indexOf(right);
            return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
        });
    }

    function discoverResultTypes() {
        var requestId = state.requestId;
        var enabledTypes = getEnabledTypes();
        var probeLimit = Math.min(500, Math.max(getPageSize(), enabledTypes.length * 25));

        return queryAllItems(probeLimit)
            .then(normalizeItems)
            .then(function (result) {
                if (requestId !== state.requestId) {
                    return;
                }

                var discovered = new Set();
                result.items.forEach(function (item) {
                    if (item && enabledTypes.indexOf(item.Type) !== -1) {
                        discovered.add(item.Type);
                    }
                });

                var types = sortTypes(enabledTypes.filter(function (type) {
                    return discovered.has(type);
                }));

                if (!types.length) {
                    render();
                    return;
                }

                types.forEach(function (type) {
                    loadSection(type, 0);
                });
            })
            .catch(function () {
                sortTypes(enabledTypes).forEach(function (type) {
                    loadSection(type, 0);
                });
            });
    }

    function searchNow() {
        prehideSearchUi();
        if (!state.config || state.config.enabled === false) {
            removeRoot();
            return;
        }

        if (!isSearchLocation() || !state.searchPage || !state.resultsElement) {
            removeRoot();
            return;
        }

        var term = getSearchTerm();
        if (!term) {
            state.query = "";
            state.requestId += 1;
            state.sections = {};
            state.results = null;
            state.availableTypes = [];
            state.typeCounts = {};
            state.countsLoading = false;
            render();
            return;
        }

        var routeParams = getRouteParams();
        var routeType = routeParams.type;
        var routeStartIndex = routeParams.startIndex || 0;
        if (term === state.query && state.root) {
            if (routeType && state.availableTypes.indexOf(routeType) !== -1 && routeType !== state.activeType) {
                state.activeType = routeType;
                state.requestId += 1;
                loadResults(routeStartIndex);
                return;
            }

            if (state.results && routeStartIndex !== state.results.startIndex) {
                state.requestId += 1;
                loadResults(routeStartIndex);
                return;
            }

            return;
        }

        state.query = term;
        state.activeType = routeType || state.activeType;
        state.requestId += 1;
        state.sections = {};
        state.results = null;
        state.availableTypes = [];
        state.typeCounts = {};
        setStatus("Searching...", "better-jellyfin-search-status");

        loadAvailableTypes().then(function () {
            loadResults(routeStartIndex);
        });
    }

    function scheduleSearch() {
        window.clearTimeout(state.debounceTimer);
        state.debounceTimer = window.setTimeout(searchNow, 250);
    }

    function bindSearchInput() {
        var input = getSearchTextInput();
        if (!input || input.dataset.betterJellyfinSearchBound === "true") {
            return;
        }

        function handleNativeInput() {
            updateSearchRoute(input.value.trim());
            scheduleSearch();
        }

        input.dataset.betterJellyfinSearchBound = "true";
        input.addEventListener("input", handleNativeInput);
        input.addEventListener("change", handleNativeInput);
        input.addEventListener("keyup", handleNativeInput);
    }

    function patchHistory() {
        if (window.__betterJellyfinSearchHistoryPatched) {
            return;
        }

        window.__betterJellyfinSearchHistoryPatched = true;
        ["pushState", "replaceState"].forEach(function (method) {
            var original = history[method];
            history[method] = function () {
                var result = original.apply(this, arguments);
                window.dispatchEvent(new Event("better-jellyfin-search-locationchange"));
                return result;
            };
        });

        window.addEventListener("popstate", function () {
            window.dispatchEvent(new Event("better-jellyfin-search-locationchange"));
        });
        window.addEventListener("hashchange", function () {
            window.dispatchEvent(new Event("better-jellyfin-search-locationchange"));
        });
    }

    function initOnSearchPage() {
        prehideSearchUi();
        if (!isSearchLocation()) {
            removeRoot();
            return;
        }

        waitFor(function () {
            var page = getSearchPage();
            var results = getResultsElement(page);
            if (!page || !results) {
                return null;
            }

            return {
                page: page,
                results: results
            };
        }, 10000).then(function (elements) {
            state.searchPage = elements.page;
            state.resultsElement = elements.results;
            ensureStylesheet();
            bindSearchInput();
            searchNow();
        }).catch(function () {
            removeRoot();
        });
    }

    function loadConfig() {
        return fetch(CONFIG_URL, {
            credentials: "same-origin",
            headers: {
                Accept: "application/json"
            }
        }).then(function (response) {
            if (!response.ok) {
                throw new Error("Better Jellyfin Search config request failed");
            }

            return response.json();
        }).then(function (config) {
            state.config = config || {};
        }).catch(function () {
            state.config = {
                enabled: false,
                pageSize: 100,
                sectionMode: "type-sections",
                includeItemTypes: DEFAULT_TYPES
            };
        });
    }

    function ensureStylesheet() {
        var existing = document.querySelector("link[data-better-jellyfin-search-stylesheet='true']");
        if (existing) {
            if (existing.sheet) {
                markStylesheetReady();
            }
            return;
        }

        var link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = CSS_URL + "?v=" + encodeURIComponent(state.config && state.config.version || "active");
        link.dataset.betterJellyfinSearchStylesheet = "true";
        link.addEventListener("load", markStylesheetReady);
        link.addEventListener("error", markStylesheetReady);
        document.head.appendChild(link);
        window.setTimeout(markStylesheetReady, 1000);
    }

    function markStylesheetReady() {
        state.stylesheetReady = true;
        if (state.root) {
            state.root.classList.add("is-styled");
            state.root.style.visibility = "";
        }
    }

    function boot() {
        prehideSearchUi();
        patchHistory();
        bindSortMenuDismiss();
        loadConfig().then(function () {
            if (!state.config || state.config.enabled === false) {
                return;
            }

            initOnSearchPage();
        });
        window.addEventListener("better-jellyfin-search-locationchange", function () {
            prehideSearchUi();
            if (!state.config || state.config.enabled === false) {
                return;
            }

            if (state.suppressNextLocationChange) {
                state.suppressNextLocationChange = false;
                return;
            }

            window.setTimeout(initOnSearchPage, 100);
        });

        var observer = new MutationObserver(function () {
            if (isSearchLocation()) {
                bindSearchInput();
                scheduleSearch();
            }
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
}());
