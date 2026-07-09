import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// One source, two deployments:
//   GitHub Pages: DOCS_BASE_URL=/home-lab/  → briancaffey.github.io/home-lab/
//   In-cluster (docs.lan): DOCS_BASE_URL=/  (default)
const baseUrl = process.env.DOCS_BASE_URL ?? '/';

const config: Config = {
  title: "Brian's Home Lab",
  tagline: 'Four machines, forty services, one GitOps loop — and the agents that run it',
  favicon: 'img/favicon.ico',
  url: 'https://briancaffey.github.io',
  baseUrl,
  organizationName: 'briancaffey',
  projectName: 'home-lab',
  onBrokenLinks: 'throw',
  markdown: {
    mermaid: true,
    hooks: {onBrokenMarkdownLinks: 'warn'},
  },
  themes: ['@docusaurus/theme-mermaid', ['@easyops-cn/docusaurus-search-local', {
    hashed: true,
    language: ['en', 'zh'],
    highlightSearchTermsOnTargetPage: true,
  }]],
  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'zh-Hans'],
    localeConfigs: {
      en: {label: 'English'},
      'zh-Hans': {label: '简体中文'},
    },
  },
  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          routeBasePath: '/',
          editUrl: 'https://github.com/briancaffey/home-lab/tree/main/docs-site/',
        },
        blog: {
          showReadingTime: true,
          blogTitle: 'Lab notes',
          blogDescription: 'Milestones and lessons from building the home lab',
          onInlineAuthors: 'ignore',
          onUntruncatedBlogPosts: 'ignore',
        },
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    image: 'img/social-card.png',
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: "Brian's Home Lab",
      logo: {alt: 'home-lab', src: 'img/logo.svg'},
      items: [
        {type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs'},
        {to: '/blog', label: 'Lab notes', position: 'left'},
        {href: 'https://github.com/briancaffey/home-lab', label: 'GitHub', position: 'right'},
        {type: 'localeDropdown', position: 'right'},
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'The Lab',
          items: [
            {label: 'The tour', to: '/'},
            {label: 'Hardware', to: '/hardware/nodes'},
            {label: 'clusterscape (3D explorer)', href: 'https://briancaffey.github.io/clusterscape/'},
          ],
        },
        {
          title: 'Elsewhere',
          items: [
            {label: 'GitHub', href: 'https://github.com/briancaffey/home-lab'},
            {label: 'briancaffey.github.io', href: 'https://briancaffey.github.io'},
          ],
        },
      ],
      copyright: `Built with Docusaurus. Content © ${new Date().getFullYear()} Brian Caffey — written with (and about) AI agents.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'yaml', 'json'],
    },
    mermaid: {
      theme: {light: 'neutral', dark: 'dark'},
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
