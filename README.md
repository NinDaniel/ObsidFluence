# ObsidFluence

Sync Confluence Cloud pages to Obsidian with proper folder structure and formatting.

## Features

- **Hierarchical Structure Preservation**: Maintains Confluence's page hierarchy in Obsidian
  - Pages with children become folders with `index.md`
  - Leaf pages become regular `.md` files
- **Smart Version Control**: Only syncs pages when Confluence version is newer
- **Rich Content Conversion**: Converts Confluence Storage Format to Markdown
  - Code blocks with syntax highlighting
  - Expand macros → Obsidian collapsible callouts
  - Info/warning/note panels → Obsidian callouts
  - Internal page links → Obsidian wiki links
  - Tables, images, lists, and formatting
- **Attachment Support**: Downloads and links images and attachments with relative paths
- **Automatic Sync**: Configurable sync intervals
- **Conflict Resolution**: Choose how to handle conflicts between Confluence and Obsidian versions

## Installation

### From Release (Recommended)

1. Download the latest release from the [Releases page](https://github.com/NinDaniel/ObsidFluence/releases)
2. Extract the files into your vault's `.obsidian/plugins/obsidfluence/` folder
3. Reload Obsidian
4. Enable the plugin in Settings → Community Plugins

### Manual Installation

1. Clone this repository
2. Run `npm install` to install dependencies
3. Run `npm run build` to build the plugin
4. Copy `main.js` and `manifest.json` to your vault's `.obsidian/plugins/obsidfluence/` folder
5. Reload Obsidian
6. Enable the plugin in Settings → Community Plugins

## Configuration

1. Open Obsidian Settings
2. Navigate to Community Plugins → ObsidFluence
3. Configure the following settings:

### Required Settings

- **Confluence URL**: Your Confluence Cloud URL (e.g., `https://yourcompany.atlassian.net`)
- **Email**: Your Confluence account email
- **API Token**: Generate from [Atlassian Account Settings](https://id.atlassian.com/manage-profile/security/api-tokens)
- **Space Keys**: Comma-separated list of space keys to sync (e.g., `PROJ,TEAM`)

### Optional Settings

- **Sync Folder**: Folder in your vault for Confluence content (default: `Confluence`, leave empty to sync to vault root)
- **Sync Interval**: Auto-sync frequency in minutes (0 to disable)
- **Conflict Resolution**: How to handle version conflicts
  - `Ask me`: Prompt for each conflict (default)
  - `Always use Confluence version`: Confluence always wins
  - `Always use Obsidian version`: Keep local changes
- **Download Attachments**: Enable/disable attachment downloading
- **Flatten Single Root Page**: When enabled, if a space has only one root page, skip its folder and sync content directly to the space folder (reduces nesting depth)

## Usage

### Manual Sync

- Click the sync icon in the ribbon, or
- Use the command palette: `Ctrl/Cmd + P` → "Sync now"

### Force Full Sync

If you need to re-sync all pages (e.g., after deleting local files):
- Use the command palette: `Ctrl/Cmd + P` → "Force full sync (ignore last sync time)"

This clears the last sync timestamp and fetches all pages from Confluence.

### Automatic Sync

Set a sync interval in settings to enable automatic syncing.

## Folder Structure Example

### Normal Structure

```
Confluence/
└── Space Name/
    ├── Parent Page/
    │   ├── index.md
    │   ├── attachments/
    │   │   └── diagram.png
    │   ├── Child Page 1.md
    │   └── Child Page 2/
    │       ├── index.md
    │       └── Grandchild Page.md
    └── Another Root Page.md
```

### Flattened Single Root Page (Setting Enabled)

When a space has only one root page and "Flatten Single Root Page" is enabled:

```
Confluence/
└── Space Name/
    ├── index.md              ← Root page content
    ├── attachments/
    │   └── diagram.png
    ├── Child Page 1.md        ← Direct children (no extra folder)
    └── Child Page 2/
        ├── index.md
        └── Grandchild Page.md
```

This reduces one level of nesting for spaces with a single root page.

## Page Metadata

Each synced page includes frontmatter with metadata:

```yaml
---
confluenceId: 123456789
version: 5
lastSynced: 2024-01-20T10:30:00.000Z
spaceKey: PROJ
title: Page Title
webUrl: https://yourcompany.atlassian.net/wiki/spaces/PROJ/pages/123456789
---
```

## Development

### Prerequisites

- Node.js (v20+)
- npm

### Setup

```bash
# Install dependencies
npm install

# Development mode (watch)
npm run dev

# Production build
npm run build

# Type checking
npm run build
```

### Project Structure

- `main.ts`: Main plugin code
- `manifest.json`: Plugin metadata
- `esbuild.config.mjs`: Build configuration
- `CLAUDE.md`: Architecture documentation for AI assistants

## Supported Confluence Elements

- ✅ Headers (H1-H6)
- ✅ Text formatting (bold, italic, underline, strikethrough)
- ✅ Code blocks with syntax highlighting
- ✅ Inline code
- ✅ Lists (ordered and unordered)
- ✅ Tables
- ✅ Images and attachments
- ✅ Internal page links
- ✅ External links
- ✅ Blockquotes
- ✅ Horizontal rules
- ✅ Expand macros (collapsible sections)
- ✅ Info/warning/note/tip panels

## Known Limitations

- **One-way sync**: Obsidian → Confluence sync not supported
- **Some macros unsupported**: Complex Confluence macros may not convert perfectly
- **Confluence Cloud only**: Server/Data Center versions not supported

## Troubleshooting

### Sync fails with authentication error

- Verify your email and API token are correct
- Ensure the API token has proper permissions
- Check that your Confluence URL includes the full domain

### Pages not syncing

- Verify the space keys are correct (case-sensitive)
- Check console logs (Ctrl/Cmd + Shift + I) for detailed error messages
- Ensure you have read permissions for the spaces

### Children pages not found

The plugin tries multiple API endpoints to find child pages. If children still don't sync, they may be in an unsupported structure (e.g., archived pages).

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

If you encounter issues or have questions:
- Open an issue on [GitHub](https://github.com/NinDaniel/ObsidFluence/issues)
- Check existing issues for solutions

## Acknowledgments

Built for the Obsidian community to bridge Confluence and Obsidian workflows.
