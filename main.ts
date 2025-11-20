import { App, Notice, Plugin, PluginSettingTab, Setting, TFolder, TFile, requestUrl } from 'obsidian';

interface ConfluenceSyncSettings {
	confluenceUrl: string;
	email: string;
	apiToken: string;
	spaceKeys: string[];
	syncIntervalMinutes: number;
	conflictResolution: 'confluence' | 'obsidian' | 'ask';
	syncFolder: string;
	downloadAttachments: boolean;
	lastSyncTimes: Record<string, string>; // spaceKey -> ISO timestamp
}

const DEFAULT_SETTINGS: ConfluenceSyncSettings = {
	confluenceUrl: '',
	email: '',
	apiToken: '',
	spaceKeys: [],
	syncIntervalMinutes: 60,
	conflictResolution: 'ask',
	syncFolder: 'Confluence',
	downloadAttachments: true,
	lastSyncTimes: {}
};

interface ConfluencePage {
	id: string;
	type: string;
	status: string;
	title: string;
	space: {
		key: string;
		name: string;
	};
	version: {
		number: number;
		when: string;
	};
	ancestors: Array<{
		id: string;
		title: string;
	}>;
	body?: {
		storage?: {
			value: string;
		};
	};
	children?: {
		page?: {
			results: ConfluencePage[];
		};
	};
	_links?: {
		webui: string;
	};
}

interface PageMetadata {
	confluenceId: string;
	version: number;
	lastSynced: string;
	spaceKey: string;
	title: string;
	webUrl: string;
}

export default class ConfluenceSyncPlugin extends Plugin {
	settings: ConfluenceSyncSettings;
	syncIntervalId: number | null = null;
	isSyncing: boolean = false;

	async onload() {
		await this.loadSettings();

		// Add ribbon icon
		this.addRibbonIcon('sync', 'Sync Confluence', async () => {
			await this.syncNow();
		});

		// Add command
		this.addCommand({
			id: 'sync-confluence',
			name: 'Sync now',
			callback: async () => {
				await this.syncNow();
			}
		});

		// Add settings tab
		this.addSettingTab(new ConfluenceSyncSettingTab(this.app, this));

		// Start automatic sync if configured
		if (this.settings.confluenceUrl && this.settings.apiToken) {
			this.startAutoSync();
		}
	}

	onunload() {
		this.stopAutoSync();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	startAutoSync() {
		this.stopAutoSync();
		if (this.settings.syncIntervalMinutes > 0) {
			this.syncIntervalId = window.setInterval(
				() => this.syncNow(),
				this.settings.syncIntervalMinutes * 60 * 1000
			);
			this.registerInterval(this.syncIntervalId);
		}
	}

	stopAutoSync() {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
	}

	async syncNow() {
		if (this.isSyncing) {
			new Notice('Sync already in progress');
			return;
		}

		if (!this.settings.confluenceUrl || !this.settings.apiToken) {
			new Notice('Please configure Confluence settings first');
			return;
		}

		this.isSyncing = true;
		new Notice('Starting Confluence sync...');

		try {
			await this.performSync();
			new Notice('Confluence sync completed successfully');
		} catch (error) {
			console.error('Sync error:', error);
			new Notice(`Sync failed: ${error.message}`);
		} finally {
			this.isSyncing = false;
		}
	}

	async performSync() {
		const confluenceApi = new ConfluenceAPI(
			this.settings.confluenceUrl,
			this.settings.email,
			this.settings.apiToken
		);

		// Ensure sync folder exists
		const syncFolder = this.settings.syncFolder;
		await this.ensureFolder(syncFolder);

		// Sync each space
		for (const spaceKey of this.settings.spaceKeys) {
			await this.syncSpace(confluenceApi, spaceKey);
		}
	}

	async syncSpace(api: ConfluenceAPI, spaceKey: string) {
		console.log(`Syncing space: ${spaceKey}`);

		// Get space info
		const space = await api.getSpace(spaceKey);
		const spaceFolderPath = `${this.settings.syncFolder}/${this.sanitizeFileName(space.name)}`;
		await this.ensureFolder(spaceFolderPath);

		const syncStartTime = new Date().toISOString();
		const lastSyncTime = this.settings.lastSyncTimes[spaceKey];

		let pages: ConfluencePage[];

		if (lastSyncTime) {
			// Incremental sync: only get pages modified since last sync
			console.log(`Incremental sync: fetching pages modified since ${lastSyncTime}`);
			pages = await api.searchPagesByDate(spaceKey, lastSyncTime, true);
			console.log(`Found ${pages.length} updated pages`);
		} else {
			// First sync: get all pages with children info
			console.log(`First sync: fetching all pages in space`);
			pages = await api.getSpacePages(spaceKey, true);
			console.log(`Found ${pages.length} total pages`);
		}

		// Build page lookup map: pageId -> page (for quick access to page details)
		const pageMap = new Map<string, ConfluencePage>();
		for (const page of pages) {
			pageMap.set(page.id, page);
		}

		// Build hierarchy map: pageId -> children page IDs
		const hierarchyMap = new Map<string, string[]>();
		for (const page of pages) {
			if (page.children?.page?.results) {
				hierarchyMap.set(page.id, page.children.page.results.map(child => child.id));
			} else {
				hierarchyMap.set(page.id, []);
			}
		}

		if (lastSyncTime) {
			// Incremental sync: process each updated page at its correct location
			console.log(`Processing ${pages.length} updated pages`);
			for (const page of pages) {
				// Reconstruct parent path from ancestors
				let parentPath = spaceFolderPath;
				if (page.ancestors && page.ancestors.length > 0) {
					for (const ancestor of page.ancestors) {
						parentPath = `${parentPath}/${this.sanitizeFileName(ancestor.title)}`;
					}
				}
				const depth = page.ancestors ? page.ancestors.length : 0;
				await this.syncPage(api, page, parentPath, depth, hierarchyMap, pageMap);
			}
		} else {
			// First sync: process root pages recursively
			const rootPages = pages.filter(p => !p.ancestors || p.ancestors.length === 0);
			console.log(`Found ${rootPages.length} root pages in space ${spaceKey}`);
			for (const page of rootPages) {
				await this.syncPage(api, page, spaceFolderPath, 0, hierarchyMap, pageMap);
			}
		}

		// Save last sync time
		this.settings.lastSyncTimes[spaceKey] = syncStartTime;
		await this.saveSettings();
		console.log(`Updated last sync time for ${spaceKey} to ${syncStartTime}`);
	}

	async syncPage(api: ConfluenceAPI, page: ConfluencePage, parentPath: string, depth: number = 0, hierarchyMap?: Map<string, string[]>, pageMap?: Map<string, ConfluencePage>) {
		const indent = '  '.repeat(depth);
		console.log(`${indent}Syncing page: ${page.title} (depth: ${depth})`);

		try {
			// Ensure page has version info - fetch if missing (shouldn't happen with pageMap)
			if (!page.version) {
				console.log(`${indent}  ! Page missing version info, fetching...`);
				page = await api.getPageContent(page.id);
			}

			// Get children from hierarchy map and lookup their details from pageMap
			let children: ConfluencePage[] = [];
			if (hierarchyMap && hierarchyMap.has(page.id) && pageMap) {
				const childIds = hierarchyMap.get(page.id) || [];
				// Look up full page details for each child
				children = childIds.map(id => pageMap.get(id)).filter((p): p is ConfluencePage => p !== undefined);
			} else if (hierarchyMap && hierarchyMap.has(page.id)) {
				// Fallback: if we have hierarchy but no pageMap (shouldn't happen)
				console.log(`${indent}  ! No pageMap, fetching children via API`);
				children = await api.getPageChildren(page.id);
			} else {
				// Fallback to API call if no hierarchy map provided
				children = await api.getPageChildren(page.id);
			}
			const hasChildren = children.length > 0;
			console.log(`${indent}  → Has ${children.length} children`);

			let pagePath: string;
			let contentPath: string;

			if (hasChildren) {
				// Page has children: create folder with index.md
				pagePath = `${parentPath}/${this.sanitizeFileName(page.title)}`;
				await this.ensureFolder(pagePath);
				contentPath = `${pagePath}/index.md`;
			} else {
				// Leaf page: create as regular file
				pagePath = parentPath;
				contentPath = `${parentPath}/${this.sanitizeFileName(page.title)}.md`;
			}

			// Check if we need to update this page BEFORE downloading content
			const existingFile = this.app.vault.getAbstractFileByPath(contentPath);
			let shouldUpdate = true;

			if (existingFile instanceof TFile) {
				const existingMetadata = await this.extractMetadataFromFile(existingFile);
				if (existingMetadata && existingMetadata.version >= page.version.number) {
					console.log(`${indent}  ↓ Skipping (v${page.version.number}, local is v${existingMetadata.version})`);
					shouldUpdate = false;
				} else {
					console.log(`${indent}  ↓ Updating (v${existingMetadata?.version || 0} → v${page.version.number})`);
				}
			} else {
				console.log(`${indent}  ↓ Creating new file`);
			}

			// Only fetch full content if we need to update
			if (shouldUpdate) {
				// Get full page content (heavy operation)
				const fullPage = await api.getPageContent(page.id);

				// Download attachments if enabled
				const attachmentsFolder = hasChildren ? `${pagePath}/attachments` : `${parentPath}/attachments`;
				if (this.settings.downloadAttachments && fullPage.body?.storage?.value) {
					await this.downloadAttachments(api, fullPage, attachmentsFolder);
				}

				// Convert content
				const markdown = this.convertToMarkdown(fullPage, contentPath, attachmentsFolder);

				// Add frontmatter
				const metadata: PageMetadata = {
					confluenceId: page.id,
					version: page.version.number,
					lastSynced: new Date().toISOString(),
					spaceKey: page.space.key,
					title: page.title,
					webUrl: `${this.settings.confluenceUrl}${page._links?.webui || ''}`
				};

				const frontmatter = this.createFrontmatter(metadata);
				const fullContent = frontmatter + '\n\n' + markdown;

				// Save the file
				if (existingFile instanceof TFile) {
					await this.app.vault.modify(existingFile, fullContent);
				} else {
					await this.app.vault.create(contentPath, fullContent);
				}
			}

			// Recursively sync children
			if (hasChildren) {
				console.log(`${indent}  → Syncing ${children.length} children...`);
				for (const child of children) {
					await this.syncPage(api, child, pagePath, depth + 1, hierarchyMap, pageMap);
				}
			}
		} catch (error) {
			console.error(`${indent}Error syncing page "${page.title}":`, error);
			throw error;
		}
	}

	async extractMetadataFromFile(file: TFile): Promise<PageMetadata | null> {
		const content = await this.app.vault.read(file);
		return this.extractMetadata(content);
	}

	async shouldUpdateFile(file: TFile, newMetadata: PageMetadata): Promise<boolean> {
		const existingMetadata = await this.extractMetadataFromFile(file);

		if (!existingMetadata) {
			return true; // No metadata, update
		}

		if (existingMetadata.version >= newMetadata.version) {
			// Obsidian version is same or newer
			if (this.settings.conflictResolution === 'obsidian') {
				return false;
			} else if (this.settings.conflictResolution === 'confluence') {
				return true;
			} else {
				// Ask user
				// For now, default to not updating
				return false;
			}
		}

		return true; // Confluence is newer
	}

	extractMetadata(content: string): PageMetadata | null {
		const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
		const match = content.match(frontmatterRegex);
		if (!match) return null;

		try {
			const lines = match[1].split('\n');
			const metadata: any = {};
			for (const line of lines) {
				const [key, ...valueParts] = line.split(':');
				if (key && valueParts.length > 0) {
					metadata[key.trim()] = valueParts.join(':').trim();
				}
			}
			return {
				confluenceId: metadata.confluenceId,
				version: parseInt(metadata.version),
				lastSynced: metadata.lastSynced,
				spaceKey: metadata.spaceKey,
				title: metadata.title,
				webUrl: metadata.webUrl
			};
		} catch {
			return null;
		}
	}

	createFrontmatter(metadata: PageMetadata): string {
		return `---
confluenceId: ${metadata.confluenceId}
version: ${metadata.version}
lastSynced: ${metadata.lastSynced}
spaceKey: ${metadata.spaceKey}
title: ${metadata.title}
webUrl: ${metadata.webUrl}
---`;
	}

	convertToMarkdown(page: ConfluencePage, contentPath: string, attachmentsFolder: string): string {
		let content = page.body?.storage?.value || '';

		// Handle Confluence code blocks
		content = content.replace(/<ac:structured-macro[^>]*ac:name="code"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g, (match, inner) => {
			const languageMatch = inner.match(/<ac:parameter ac:name="language">([^<]+)<\/ac:parameter>/);
			const language = languageMatch ? languageMatch[1] : '';
			const codeMatch = inner.match(/<ac:plain-text-body><!\[CDATA\[([\s\S]*?)\]\]><\/ac:plain-text-body>/);
			const code = codeMatch ? codeMatch[1] : '';
			return `\`\`\`${language}\n${code}\n\`\`\``;
		});

		// Handle expand macros - must happen BEFORE other conversions
		content = content.replace(/<ac:structured-macro[^>]*ac:name="expand"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g, (match, inner) => {
			const titleMatch = inner.match(/<ac:parameter ac:name="title">([^<]*)<\/ac:parameter>/);
			const title = titleMatch ? titleMatch[1] : 'Details';
			const bodyMatch = inner.match(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/);
			let body = bodyMatch ? bodyMatch[1] : '';

			// Mark as processed to avoid double processing
			return `\n__EXPAND_START__${title}__EXPAND_MID__${body}__EXPAND_END__\n`;
		});

		// Handle info/warning/note panels
		content = content.replace(/<ac:structured-macro[^>]*ac:name="(info|warning|note|tip)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/g, (match, type, inner) => {
			const bodyMatch = inner.match(/<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>/);
			const body = bodyMatch ? bodyMatch[1] : '';
			return `> [!${type}]\n> ${body.replace(/<[^>]+>/g, '').replace(/\n/g, '\n> ')}`;
		});

		// Handle Confluence images
		content = content.replace(/<ac:image[^>]*>([\s\S]*?)<\/ac:image>/g, (match, inner) => {
			const attachmentMatch = inner.match(/<ri:attachment ri:filename="([^"]+)"[\s\S]*?\/>/);
			if (attachmentMatch) {
				const filename = attachmentMatch[1];
				const sanitizedName = this.sanitizeFileName(filename);
				// Calculate relative path from content file to attachments folder
				const relativePath = `attachments/${sanitizedName}`;
				return `![${filename}](${relativePath})`;
			}
			// Handle URL images
			const urlMatch = inner.match(/<ri:url ri:value="([^"]+)"[\s\S]*?\/>/);
			if (urlMatch) {
				return `![](${urlMatch[1]})`;
			}
			return match;
		});

		// Handle Confluence links
		content = content.replace(/<ac:link[^>]*>([\s\S]*?)<\/ac:link>/g, (match, inner) => {
			const pageMatch = inner.match(/<ri:page ri:content-title="([^"]+)"[\s\S]*?\/>/);
			const linkBodyMatch = inner.match(/<ac:link-body>([\s\S]*?)<\/ac:link-body>/);
			const linkText = linkBodyMatch ? linkBodyMatch[1].replace(/<[^>]+>/g, '') : '';

			if (pageMatch) {
				const pageTitle = pageMatch[1];
				return `[[${pageTitle}${linkText && linkText !== pageTitle ? '|' + linkText : ''}]]`;
			}

			// External links
			const urlMatch = inner.match(/<ri:url ri:value="([^"]+)"[\s\S]*?\/>/);
			if (urlMatch) {
				return linkText ? `[${linkText}](${urlMatch[1]})` : urlMatch[1];
			}

			return linkText || match;
		});

		// Handle tables - convert to Markdown
		content = this.convertTables(content);

		// Convert standard HTML to Markdown
		content = content
			// Headers
			.replace(/<h1[^>]*>(.*?)<\/h1>/gs, '# $1\n\n')
			.replace(/<h2[^>]*>(.*?)<\/h2>/gs, '## $1\n\n')
			.replace(/<h3[^>]*>(.*?)<\/h3>/gs, '### $1\n\n')
			.replace(/<h4[^>]*>(.*?)<\/h4>/gs, '#### $1\n\n')
			.replace(/<h5[^>]*>(.*?)<\/h5>/gs, '##### $1\n\n')
			.replace(/<h6[^>]*>(.*?)<\/h6>/gs, '###### $1\n\n')
			// Bold
			.replace(/<strong[^>]*>(.*?)<\/strong>/gs, '**$1**')
			.replace(/<b[^>]*>(.*?)<\/b>/gs, '**$1**')
			// Italic
			.replace(/<em[^>]*>(.*?)<\/em>/gs, '*$1*')
			.replace(/<i[^>]*>(.*?)<\/i>/gs, '*$1*')
			// Underline (use HTML in markdown)
			.replace(/<u[^>]*>(.*?)<\/u>/gs, '<u>$1</u>')
			// Strikethrough
			.replace(/<s[^>]*>(.*?)<\/s>/gs, '~~$1~~')
			.replace(/<strike[^>]*>(.*?)<\/strike>/gs, '~~$1~~')
			.replace(/<del[^>]*>(.*?)<\/del>/gs, '~~$1~~')
			// Code inline
			.replace(/<code[^>]*>(.*?)<\/code>/gs, '`$1`')
			// Pre blocks (if not already handled by code macro)
			.replace(/<pre[^>]*>(.*?)<\/pre>/gs, '```\n$1\n```')
			// Blockquotes
			.replace(/<blockquote[^>]*>(.*?)<\/blockquote>/gs, (match, content) => {
				return '> ' + content.trim().replace(/\n/g, '\n> ') + '\n\n';
			})
			// Lists - unordered
			.replace(/<ul[^>]*>([\s\S]*?)<\/ul>/gs, (match, content) => {
				return content.replace(/<li[^>]*>(.*?)<\/li>/gs, '- $1\n') + '\n';
			})
			// Lists - ordered
			.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gs, (match, content) => {
				let counter = 1;
				return content.replace(/<li[^>]*>(.*?)<\/li>/gs, () => {
					return `${counter++}. ${RegExp.$1}\n`;
				}) + '\n';
			})
			// Paragraphs
			.replace(/<p[^>]*>(.*?)<\/p>/gs, '$1\n\n')
			// Line breaks
			.replace(/<br\s*\/?>/g, '\n')
			// Horizontal rules
			.replace(/<hr\s*\/?>/g, '\n---\n')
			// Remove remaining Confluence namespaced tags
			.replace(/<\/?ac:[^>]+>/g, '')
			.replace(/<\/?ri:[^>]+>/g, '')
			// Remove span and div tags but keep content
			.replace(/<\/?span[^>]*>/g, '')
			.replace(/<\/?div[^>]*>/g, '')
			// Remove any remaining HTML tags EXCEPT details and summary (for expand macros)
			.replace(/<\/?(?!details|summary)[a-z][^>]*>/gi, '')
			// Clean up excessive newlines
			.replace(/\n{3,}/g, '\n\n');

		// Decode HTML entities AFTER removing tags
		content = this.decodeHtmlEntities(content);

		// Convert expand markers back to Obsidian callout syntax AFTER all processing
		content = content.replace(/__EXPAND_START__([^_]+)__EXPAND_MID__([\s\S]*?)__EXPAND_END__/g, (match, title, body) => {
			// Use Obsidian's collapsible callout syntax (the - makes it collapsed by default)
			// Prefix each line of the body with "> " to make it part of the callout
			const bodyLines = body.trim().split('\n').map((line: string) => '> ' + line).join('\n');
			return `\n\n> [!info]- ${title}\n${bodyLines}\n\n`;
		});

		return content.trim();
	}

	convertTables(content: string): string {
		// Simple table conversion - handles basic Confluence/HTML tables
		content = content.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (match, tableContent) => {
			const rows: string[] = [];

			// Extract rows
			const rowMatches = tableContent.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
			if (!rowMatches) return match;

			let isFirstRow = true;
			for (const rowMatch of rowMatches) {
				const cells: string[] = [];

				// Extract cells (th or td)
				const cellMatches = rowMatch.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi);
				if (!cellMatches) continue;

				for (const cellMatch of cellMatches) {
					// Remove tags and get content
					const cellContent = cellMatch
						.replace(/<t[hd][^>]*>/i, '')
						.replace(/<\/t[hd]>/i, '')
						.replace(/<[^>]+>/g, '')
						.trim();
					cells.push(cellContent);
				}

				if (cells.length > 0) {
					rows.push('| ' + cells.join(' | ') + ' |');

					// Add separator after first row
					if (isFirstRow) {
						rows.push('| ' + cells.map(() => '---').join(' | ') + ' |');
						isFirstRow = false;
					}
				}
			}

			return rows.length > 0 ? '\n' + rows.join('\n') + '\n' : match;
		});

		return content;
	}

	async downloadAttachments(api: ConfluenceAPI, page: ConfluencePage, attachmentsFolder: string) {
		const attachments = await api.getPageAttachments(page.id);
		console.log(`Page "${page.title}" has ${attachments.length} attachments`);

		if (attachments.length === 0) return;

		await this.ensureFolder(attachmentsFolder);

		for (const attachment of attachments) {
			try {
				console.log(`Downloading attachment: ${attachment.title}`);
				const fileName = this.sanitizeFileName(attachment.title);
				const filePath = `${attachmentsFolder}/${fileName}`;

				// Check if file already exists
				const existingFile = this.app.vault.getAbstractFileByPath(filePath);

				const data = await api.downloadAttachment(attachment);

				if (existingFile instanceof TFile) {
					// Update existing file
					console.log(`Updated existing attachment: ${filePath}`);
					await this.app.vault.modifyBinary(existingFile, data);
				} else {
					// Create new file
					console.log(`Created new attachment: ${filePath}`);
					await this.app.vault.createBinary(filePath, data);
				}
			} catch (error) {
				console.error(`Failed to download attachment ${attachment.title}:`, error);
			}
		}
	}

	decodeHtmlEntities(text: string): string {
		const entities: Record<string, string> = {
			'&nbsp;': ' ',
			'&quot;': '"',
			'&apos;': "'",
			'&#39;': "'",
			'&rsquo;': "'",
			'&lsquo;': "'",
			'&rdquo;': '"',
			'&ldquo;': '"',
			'&mdash;': '—',
			'&ndash;': '–',
			'&hellip;': '…',
			'&amp;': '&',
			'&lt;': '<',
			'&gt;': '>',
			'&aelig;': 'æ',
			'&AElig;': 'Æ',
			'&oslash;': 'ø',
			'&Oslash;': 'Ø',
			'&aring;': 'å',
			'&Aring;': 'Å',
			'&ouml;': 'ö',
			'&uuml;': 'ü',
			'&auml;': 'ä',
			'&eacute;': 'é',
			'&egrave;': 'è',
			'&ntilde;': 'ñ',
			'&#8217;': "'",
			'&#8216;': "'",
			'&#8220;': '"',
			'&#8221;': '"',
			'&#8212;': '—',
			'&#8211;': '–',
			'&#8230;': '…'
		};

		let decoded = text;
		// Replace known entities
		for (const [entity, char] of Object.entries(entities)) {
			decoded = decoded.replace(new RegExp(entity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), char);
		}

		// Decode numeric entities (decimal)
		decoded = decoded.replace(/&#(\d+);/g, (match, dec) => {
			return String.fromCharCode(parseInt(dec));
		});

		// Decode hex entities
		decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
			return String.fromCharCode(parseInt(hex, 16));
		});

		return decoded;
	}

	sanitizeFileName(name: string): string {
		return name.replace(/[\\/:*?"<>|]/g, '-').trim();
	}

	async ensureFolder(path: string) {
		const folders = path.split('/');
		let currentPath = '';

		for (const folder of folders) {
			currentPath = currentPath ? `${currentPath}/${folder}` : folder;
			const existing = this.app.vault.getAbstractFileByPath(currentPath);
			if (!existing) {
				await this.app.vault.createFolder(currentPath);
			}
		}
	}
}

class ConfluenceAPI {
	constructor(
		private baseUrl: string,
		private email: string,
		private apiToken: string
	) {
		// Remove trailing slash from baseUrl
		this.baseUrl = baseUrl.replace(/\/$/, '');
	}

	private getAuthHeader(): string {
		return 'Basic ' + btoa(`${this.email}:${this.apiToken}`);
	}

	private formatDateForCQL(isoDate: string): string {
		// Convert ISO 8601 to CQL date format: "yyyy-MM-dd HH:mm"
		const date = new Date(isoDate);
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		const hours = String(date.getHours()).padStart(2, '0');
		const minutes = String(date.getMinutes()).padStart(2, '0');
		return `${year}-${month}-${day} ${hours}:${minutes}`;
	}

	async getSpace(spaceKey: string) {
		const response = await requestUrl({
			url: `${this.baseUrl}/wiki/rest/api/space/${spaceKey}`,
			method: 'GET',
			headers: {
				'Authorization': this.getAuthHeader(),
				'Accept': 'application/json'
			}
		});
		return response.json;
	}

	async getSpacePages(spaceKey: string, includeChildren: boolean = false): Promise<ConfluencePage[]> {
		const pages: ConfluencePage[] = [];
		let start = 0;
		const limit = 100;

		// Include children.page in expand to reduce API calls
		const expand = includeChildren
			? 'version,space,ancestors,children.page'
			: 'version,space,ancestors';

		while (true) {
			const response = await requestUrl({
				url: `${this.baseUrl}/wiki/rest/api/space/${spaceKey}/content/page?limit=${limit}&start=${start}&expand=${expand}`,
				method: 'GET',
				headers: {
					'Authorization': this.getAuthHeader(),
					'Accept': 'application/json'
				}
			});

			const data = response.json;
			pages.push(...data.results);

			if (data.results.length < limit) {
				break;
			}
			start += limit;
		}

		return pages;
	}

	async searchPagesByDate(spaceKey: string, since: string, includeChildren: boolean = false): Promise<ConfluencePage[]> {
		const pages: ConfluencePage[] = [];
		let start = 0;
		const limit = 100;

		// Include children.page in expand to reduce API calls
		const expand = includeChildren
			? 'version,space,ancestors,children.page'
			: 'version,space,ancestors';

		// CQL query: get pages modified since last sync
		// Convert ISO timestamp to CQL-compatible format
		const cqlDate = this.formatDateForCQL(since);
		const cql = `space = "${spaceKey}" AND type = page AND lastModified >= "${cqlDate}"`;

		while (true) {
			const response = await requestUrl({
				url: `${this.baseUrl}/wiki/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${limit}&start=${start}&expand=${expand}`,
				method: 'GET',
				headers: {
					'Authorization': this.getAuthHeader(),
					'Accept': 'application/json'
				}
			});

			const data = response.json;
			pages.push(...data.results);

			if (data.results.length < limit) {
				break;
			}
			start += limit;
		}

		return pages;
	}

	async getPageContent(pageId: string): Promise<ConfluencePage> {
		const response = await requestUrl({
			url: `${this.baseUrl}/wiki/rest/api/content/${pageId}?expand=body.storage,version,space,ancestors,children.page`,
			method: 'GET',
			headers: {
				'Authorization': this.getAuthHeader(),
				'Accept': 'application/json'
			}
		});
		return response.json;
	}

	async getPageChildren(pageId: string): Promise<ConfluencePage[]> {
		const children: ConfluencePage[] = [];
		let start = 0;
		const limit = 100;

		while (true) {
			// Try getting all content types, then filter for pages
			const url = `${this.baseUrl}/wiki/rest/api/content/${pageId}/child/page?limit=${limit}&start=${start}&expand=version,space,ancestors&status=current`;
			console.log(`Fetching children from: ${url}`);

			const response = await requestUrl({
				url: url,
				method: 'GET',
				headers: {
					'Authorization': this.getAuthHeader(),
					'Accept': 'application/json'
				}
			});

			const data = response.json;
			console.log(`API returned ${data.results?.length || 0} children (size: ${data.size})`);

			// Also try the descendants endpoint to see if we get more results
			if (start === 0 && (!data.results || data.results.length === 0)) {
				console.log(`No direct children found, checking what content exists...`);

				// Try to get folders
				console.log(`Checking for folders...`);
				try {
					const folderUrl = `${this.baseUrl}/wiki/rest/api/content/${pageId}/child/folder?expand=version,space,ancestors&status=current`;
					const folderResponse = await requestUrl({
						url: folderUrl,
						method: 'GET',
						headers: {
							'Authorization': this.getAuthHeader(),
							'Accept': 'application/json'
						}
					});
					const folderData = folderResponse.json;
					console.log(`Found ${folderData.results?.length || 0} folders`);
					if (folderData.results && folderData.results.length > 0) {
						// Folders are like pages, so return them as children
						children.push(...folderData.results);
						return children;
					}
				} catch (e) {
					console.log(`Folder fetch failed:`, e);
				}

				// Try descendants API
				console.log(`Trying descendants API...`);
				try {
					const descUrl = `${this.baseUrl}/wiki/rest/api/content/${pageId}/descendant/page?limit=${limit}&expand=version,space,ancestors&status=current`;
					const descResponse = await requestUrl({
						url: descUrl,
						method: 'GET',
						headers: {
							'Authorization': this.getAuthHeader(),
							'Accept': 'application/json'
						}
					});
					const descData = descResponse.json;
					console.log(`Descendants API returned ${descData.results?.length || 0} pages`);

					// Filter to only direct children (those where this page is the parent)
					if (descData.results && descData.results.length > 0) {
						for (const page of descData.results) {
							// A page is a direct child if its last ancestor is this page
							const ancestors = page.ancestors || [];
							if (ancestors.length > 0 && ancestors[ancestors.length - 1].id === pageId) {
								children.push(page);
							}
						}
						console.log(`Found ${children.length} direct children from descendants API`);
						return children;
					}
				} catch (e) {
					console.log(`Descendants API failed:`, e);
				}
			}

			if (data.results) {
				children.push(...data.results);
			}

			if (!data.results || data.results.length < limit) {
				break;
			}
			start += limit;
		}

		return children;
	}

	async getPageAttachments(pageId: string) {
		const response = await requestUrl({
			url: `${this.baseUrl}/wiki/rest/api/content/${pageId}/child/attachment?expand=version`,
			method: 'GET',
			headers: {
				'Authorization': this.getAuthHeader(),
				'Accept': 'application/json'
			}
		});
		return response.json.results || [];
	}

	async downloadAttachment(attachment: any): Promise<ArrayBuffer> {
		// Construct the download URL properly
		let downloadUrl = attachment._links?.download;

		if (!downloadUrl) {
			// Try alternative download path construction
			downloadUrl = `/wiki/download/attachments/${attachment.container?.id || attachment.pageId}/${encodeURIComponent(attachment.title)}`;
		}

		// If it's a relative path, prepend the base URL
		if (downloadUrl.startsWith('/')) {
			// Check if it starts with /wiki/, if not, add it
			if (!downloadUrl.startsWith('/wiki/')) {
				downloadUrl = `/wiki${downloadUrl}`;
			}
			downloadUrl = `${this.baseUrl}${downloadUrl}`;
		}

		console.log(`Downloading: ${attachment.title} from ${downloadUrl}`);

		const response = await requestUrl({
			url: downloadUrl,
			method: 'GET',
			headers: {
				'Authorization': this.getAuthHeader()
			}
		});
		return response.arrayBuffer;
	}
}

class ConfluenceSyncSettingTab extends PluginSettingTab {
	plugin: ConfluenceSyncPlugin;

	constructor(app: App, plugin: ConfluenceSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		containerEl.createEl('h2', {text: 'ObsidFluence Settings'});

		new Setting(containerEl)
			.setName('Confluence URL')
			.setDesc('Your Confluence Cloud URL (e.g., https://yourcompany.atlassian.net)')
			.addText(text => text
				.setPlaceholder('https://yourcompany.atlassian.net')
				.setValue(this.plugin.settings.confluenceUrl)
				.onChange(async (value) => {
					this.plugin.settings.confluenceUrl = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Email')
			.setDesc('Your Confluence account email')
			.addText(text => text
				.setPlaceholder('email@example.com')
				.setValue(this.plugin.settings.email)
				.onChange(async (value) => {
					this.plugin.settings.email = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('API Token')
			.setDesc('Your Confluence API token')
			.addText(text => {
				text
					.setPlaceholder('Enter API token')
					.setValue(this.plugin.settings.apiToken)
					.onChange(async (value) => {
						this.plugin.settings.apiToken = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = 'password';
			});

		new Setting(containerEl)
			.setName('Space Keys')
			.setDesc('Comma-separated list of space keys to sync (e.g., PROJ,TEAM)')
			.addText(text => text
				.setPlaceholder('PROJ,TEAM')
				.setValue(this.plugin.settings.spaceKeys.join(','))
				.onChange(async (value) => {
					this.plugin.settings.spaceKeys = value.split(',').map(s => s.trim()).filter(s => s);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync Folder')
			.setDesc('Folder in your vault where Confluence content will be synced')
			.addText(text => text
				.setPlaceholder('Confluence')
				.setValue(this.plugin.settings.syncFolder)
				.onChange(async (value) => {
					this.plugin.settings.syncFolder = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync Interval')
			.setDesc('How often to sync (in minutes, 0 to disable automatic sync)')
			.addText(text => text
				.setPlaceholder('60')
				.setValue(String(this.plugin.settings.syncIntervalMinutes))
				.onChange(async (value) => {
					const num = parseInt(value);
					if (!isNaN(num) && num >= 0) {
						this.plugin.settings.syncIntervalMinutes = num;
						await this.plugin.saveSettings();
						this.plugin.startAutoSync();
					}
				}));

		new Setting(containerEl)
			.setName('Conflict Resolution')
			.setDesc('When both Confluence and Obsidian have been updated')
			.addDropdown(dropdown => dropdown
				.addOption('ask', 'Ask me')
				.addOption('confluence', 'Always use Confluence version')
				.addOption('obsidian', 'Always use Obsidian version')
				.setValue(this.plugin.settings.conflictResolution)
				.onChange(async (value: 'confluence' | 'obsidian' | 'ask') => {
					this.plugin.settings.conflictResolution = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Download Attachments')
			.setDesc('Download images and attachments from pages')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.downloadAttachments)
				.onChange(async (value) => {
					this.plugin.settings.downloadAttachments = value;
					await this.plugin.saveSettings();
				}));
	}
}
