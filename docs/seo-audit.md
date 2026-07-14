# ListIPs Technical SEO Audit

Audit date: 2026-07-14

Scope:

- Production frontend at `https://listips.com/`
- Production crawler endpoints (`robots.txt` and `sitemap.xml`)
- Astro frontend and Cloudflare Worker source
- Technical and on-page guidance published by [NavSEO](https://navseo.com/)

## Production baseline

The production homepage is server-rendered static HTML and already had a unique title, meta description, self-canonical, Open Graph tags, image dimensions, HTTPS redirects, and a sitemap reference. The main response was lightweight and did not depend on client-side JavaScript for its primary content.

The audit found these priority issues:

| Priority | Finding | Risk | Implemented change |
| --- | --- | --- | --- |
| Critical | Unknown paths returned the homepage with HTTP 200 | Soft 404s and duplicate homepage URLs | Added a custom `404.html`; Cloudflare Pages serves it with 404 status after deployment |
| High | `robots.txt` blocked `/login/`, `/dashboard/`, and `/settings/` while those pages used `noindex` | Crawlers could not fetch the page-level indexing directive | Removed those crawl blocks and retained `noindex, follow` on the pages |
| High | API and raw text responses had no explicit indexing control | Public or leaked endpoint URLs could appear as low-value search results | Added `X-Robots-Tag: noindex, nofollow, nosnippet` to Worker responses |
| Medium | Only the homepage was an indexable public page | Weak internal discovery and little product documentation for searchers | Added `/docs/` and `/about/`, linked from shared navigation and the sitemap |
| Medium | The site had no structured data | Product, publisher, and page relationships were less explicit | Added Organization, WebSite, SoftwareApplication, and BreadcrumbList JSON-LD |
| Medium | `/lists/new/` used a static meta-refresh fallback | Weak redirect signal and extra user delay | Added Cloudflare Pages 301 redirect rules to `/dashboard/` |
| Low | Social metadata lacked image alternative text and locale | Less complete share metadata | Added Open Graph/Twitter image alt text and `og:locale` |
| Low | Static asset caching was not declared in the Pages project | Missed repeat-load optimization | Added immutable caching for hashed Astro assets |

## Applied URL policy

| URL group | Crawl | Index | Canonical | Sitemap |
| --- | --- | --- | --- | --- |
| `/`, `/docs/`, `/about/` | Allow | Allow | Self-referencing HTTPS URL with trailing slash | Include |
| `/login/`, `/dashboard/`, `/settings/` | Allow | `noindex, follow` | Omit | Exclude |
| `/api/*`, `/u/*` Worker responses | Allow if discovered | `X-Robots-Tag: noindex, nofollow, nosnippet` | None | Exclude |
| Unknown frontend paths | Allow | `noindex, follow` on 404 document | None | Exclude |
| `/lists/new` and `/lists/new/` | Redirect | Permanent 301 to `/dashboard/` | Destination controls | Exclude |

## Guidance applied

The implementation follows NavSEO's recommended diagnostic order: discovery, access and eligibility, understanding, then experience and reliability.

- [Crawling and Indexing Basics](https://navseo.com/learn/technical-seo/crawling-and-indexing-basics/)
- [Canonical Tags and Duplicate Content](https://navseo.com/learn/technical-seo/canonical-tags-and-duplicate-content/)
- [Robots.txt](https://navseo.com/topics/robots-txt/)
- [XML Sitemap](https://navseo.com/topics/xml-sitemap/)
- [Structured Data](https://navseo.com/topics/structured-data/)
- [Internal Linking for Topical Authority](https://navseo.com/learn/on-page-seo/internal-linking-for-topical-authority/)

Not every SEO mechanism applies. ListIPs currently has one language, no pagination, no faceted navigation, and no article date requirements, so hreflang, pagination controls, and article schema were intentionally not added.

## Verification completed locally

- `astro check` passes with no errors, warnings, or hints.
- Static production build completes and generates all expected routes.
- Worker test suite passes, including the new raw-response indexing header assertion.
- Public page titles and descriptions are unique.
- Public pages use matching self-canonicals.
- Private application pages and the 404 document have `noindex` and no canonical.
- XML sitemap is well-formed and contains only the three indexable canonical URLs.
- JSON-LD parses successfully on the homepage, documentation page, and about page.
- `git diff --check` reports no whitespace errors.

## Required after deployment

1. Confirm an unknown production path returns HTTP 404 and the custom ListIPs 404 body.
2. Confirm `/lists/new` and `/lists/new/` return 301 with `Location: /dashboard/`.
3. Confirm a raw list and an API response include the intended `X-Robots-Tag` header after both Pages and Worker deployments.
4. Submit `https://listips.com/sitemap.xml` in Google Search Console and Bing Webmaster Tools.
5. Inspect `/`, `/docs/`, and `/about/` in Search Console after recrawl and confirm Google-selected canonicals match the declared URLs.
6. Run Lighthouse or PageSpeed Insights after deployment, then use field Core Web Vitals data once enough real traffic exists.
7. Keep the sitemap synchronized whenever another public indexable page is added or removed.
