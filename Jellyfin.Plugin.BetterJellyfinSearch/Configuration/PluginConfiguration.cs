using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.BetterJellyfinSearch.Configuration;

/// <summary>
/// Persistent settings for the injected search UI.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Gets or sets the per-section page size used by the browser script.
    /// </summary>
    public int PageSize { get; set; } = 100;

    /// <summary>
    /// Gets or sets the section rendering mode.
    /// </summary>
    public string SectionMode { get; set; } = "type-sections";

    /// <summary>
    /// Gets or sets item types that should be shown as sections.
    /// </summary>
    public string[] IncludeItemTypes { get; set; } =
    [
        "Movie",
        "Series",
        "Episode",
        "MusicAlbum",
        "Audio",
        "BoxSet",
        "Playlist",
        "Video",
        "Photo",
        "Folder"
    ];
}
