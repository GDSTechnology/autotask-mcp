// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://gdstechnology.github.io',
	base: '/autotask-mcp',
	integrations: [
		starlight({
			title: 'Autotask MCP',
			description: 'Model Context Protocol server for Kaseya Autotask PSA — tools for ChatGPT, Claude and n8n, built for a live tenant.',
			editLink: { baseUrl: 'https://github.com/GDSTechnology/autotask-mcp/edit/main/website/' },
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/GDSTechnology/autotask-mcp' }],
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Introduction', slug: 'getting-started/introduction' },
						{ label: 'Installation', slug: 'getting-started/installation' },
						{ label: 'Configuration', slug: 'getting-started/configuration' },
					],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Safety model', slug: 'guides/safety' },
						{ label: 'Postgres mirror', slug: 'guides/mirror' },
						{ label: 'Admin console', slug: 'guides/console' },
						{ label: 'Merges & bulk cleanup', slug: 'guides/bulk-cleanup' },
						{ label: 'Vendor billing', slug: 'guides/vendor-billing' },
						{ label: 'Throttling', slug: 'guides/throttling' },
					],
				},
				{
					label: 'Prompt Examples',
					items: [
						{ label: 'Overview', slug: 'examples/overview' },
						{ label: 'Companies & Contacts', slug: 'examples/companies-contacts' },
						{ label: 'Tickets & Support', slug: 'examples/tickets' },
						{ label: 'Projects & Tasks', slug: 'examples/projects-tasks' },
						{ label: 'Time & Billing', slug: 'examples/time-billing' },
						{ label: 'Notes & Attachments', slug: 'examples/notes-attachments' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Tools', slug: 'reference/tools' },
						{ label: 'Resources', slug: 'reference/resources' },
						{ label: 'Transports', slug: 'reference/transports' },
					],
				},
			],
		}),
	],
});
