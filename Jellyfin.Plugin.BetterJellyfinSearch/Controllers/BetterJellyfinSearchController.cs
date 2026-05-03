using System.Reflection;
using Jellyfin.Plugin.BetterJellyfinSearch.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.BetterJellyfinSearch.Controllers;

/// <summary>
/// Serves the browser injection assets and public runtime configuration.
/// </summary>
[ApiController]
[AllowAnonymous]
[Route("BetterJellyfinSearch")]
public class BetterJellyfinSearchController : ControllerBase
{
    private readonly IPluginManager _pluginManager;

    /// <summary>
    /// Initializes a new instance of the <see cref="BetterJellyfinSearchController"/> class.
    /// </summary>
    /// <param name="pluginManager">Jellyfin plugin manager.</param>
    public BetterJellyfinSearchController(IPluginManager pluginManager)
    {
        _pluginManager = pluginManager;
    }

    /// <summary>
    /// Returns the stable bootstrap script injected by Nginx.
    /// </summary>
    /// <returns>The JavaScript loader asset.</returns>
    [HttpGet("bootstrap")]
    [Produces("application/javascript")]
    public IActionResult GetBootstrap()
    {
        DisableCache();
        return EmbeddedFile("Jellyfin.Plugin.BetterJellyfinSearch.Assets.bootstrap.js", "application/javascript; charset=utf-8");
    }

    /// <summary>
    /// Returns the injected browser script.
    /// </summary>
    /// <returns>The JavaScript asset.</returns>
    [HttpGet("better-jellyfin-search.js")]
    [Produces("application/javascript")]
    public IActionResult GetScript()
    {
        DisableCache();
        if (!IsPluginActive())
        {
            return Content("/* Better Jellyfin Search plugin is disabled. */", "application/javascript; charset=utf-8");
        }

        return EmbeddedFile("Jellyfin.Plugin.BetterJellyfinSearch.Assets.better-jellyfin-search.js", "application/javascript; charset=utf-8");
    }

    /// <summary>
    /// Returns styles for the injected search layout.
    /// </summary>
    /// <returns>The CSS asset.</returns>
    [HttpGet("better-jellyfin-search.css")]
    [Produces("text/css")]
    public IActionResult GetStyles()
    {
        DisableCache();
        if (!IsPluginActive())
        {
            return Content("/* Better Jellyfin Search plugin is disabled. */", "text/css; charset=utf-8");
        }

        return EmbeddedFile("Jellyfin.Plugin.BetterJellyfinSearch.Assets.better-jellyfin-search.css", "text/css; charset=utf-8");
    }

    /// <summary>
    /// Returns public, non-sensitive settings consumed by the browser script.
    /// </summary>
    /// <returns>Runtime configuration.</returns>
    [HttpGet("config")]
    [Produces("application/json")]
    public IActionResult GetConfig()
    {
        DisableCache();
        PluginConfiguration configuration = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        int pageSize = Math.Clamp(configuration.PageSize, 1, 100);

        return Ok(new
        {
            enabled = IsPluginActive(),
            version = Plugin.Instance?.Version?.ToString() ?? string.Empty,
            pageSize,
            sectionMode = string.IsNullOrWhiteSpace(configuration.SectionMode)
                ? "type-sections"
                : configuration.SectionMode,
            includeItemTypes = configuration.IncludeItemTypes
                .Where(static itemType => !string.IsNullOrWhiteSpace(itemType))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray()
        });
    }

    private bool IsPluginActive()
    {
        Plugin? plugin = Plugin.Instance;
        if (plugin is null)
        {
            return false;
        }

        LocalPlugin? localPlugin = _pluginManager.GetPlugin(plugin.Id, plugin.Version);
        if (localPlugin is null)
        {
            return true;
        }

        return localPlugin.IsEnabledAndSupported
            && localPlugin.Manifest.Status == PluginStatus.Active;
    }

    private void DisableCache()
    {
        Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";
        Response.Headers.Pragma = "no-cache";
        Response.Headers.Expires = "0";
    }

    private static FileStreamResult EmbeddedFile(string resourceName, string contentType)
    {
        Stream? stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName);
        if (stream is null)
        {
            throw new InvalidOperationException($"Embedded resource '{resourceName}' was not found.");
        }

        return new FileStreamResult(stream, contentType);
    }
}
