(function () {
    "use strict";

    var BASE_URL = "/BetterJellyfinSearch";
    var CONFIG_URL = BASE_URL + "/config";
    var SCRIPT_URL = BASE_URL + "/better-jellyfin-search.js";
    var STYLE_URL = BASE_URL + "/better-jellyfin-search.css";

    if (window.__betterJellyfinSearchLoaderStarted) {
        return;
    }

    window.__betterJellyfinSearchLoaderStarted = true;

    function appendStylesheet(version) {
        if (document.querySelector("link[data-better-jellyfin-search-stylesheet='true']")) {
            return;
        }

        var link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = STYLE_URL + "?v=" + encodeURIComponent(version);
        link.dataset.betterJellyfinSearchStylesheet = "true";
        document.head.appendChild(link);
    }

    function appendScript(version) {
        if (document.querySelector("script[data-better-jellyfin-search-main='true']")) {
            return;
        }

        var script = document.createElement("script");
        script.defer = true;
        script.src = SCRIPT_URL + "?v=" + encodeURIComponent(version);
        script.dataset.betterJellyfinSearchMain = "true";
        document.body.appendChild(script);
    }

    fetch(CONFIG_URL, {
        cache: "no-store",
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
        if (!config || config.enabled === false) {
            return;
        }

        var version = config.version || "active";
        appendStylesheet(version);
        appendScript(version);
    }).catch(function () {
        window.__betterJellyfinSearchLoaderStarted = false;
    });
}());
