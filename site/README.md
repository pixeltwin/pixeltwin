# Landing page

The static site published to GitHub Pages: `index.html`, `style.css`, `site.js` (quickstart tabs and
copy buttons; the page works without it) and `assets/`. No build step: what is here is what is served.
Every URL is relative, so it works at `https://pixeltwin.github.io/pixeltwin/` and on a custom domain.

```sh
bun scripts/site-check.ts    # local links and images exist, <img> alt + width/height, first-view weight ≤ 600 KB
bun scripts/site-images.ts   # rebuild assets/*.webp and assets/og.png from docs/screenshots/
```

CI runs the check on every push (and `test/site-check.test.ts` with `bun test`). To look at the page,
serve this directory with any static server, e.g. `bunx serve site`.

## Publishing

`.github/workflows/pages.yml` deploys `site/` on every push to `main` that touches `site/**`, and
on demand (Actions → Pages → Run workflow). Once, before the first deploy:

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. Run the workflow (or push a change under `site/`). The page is then at
   `https://pixeltwin.github.io/pixeltwin/`.

**GitHub Pages on a private repository needs a paid plan** (GitHub Pro, Team or Enterprise). On the
free plan, make the repository public first, or the deploy job fails.

### A custom domain

Optional. Pick a domain, then:

1. Add `site/CNAME` with the domain on one line (e.g. `pixeltwin.dev`); there is none until a domain
   is chosen.
2. At your DNS provider, point the domain at GitHub Pages (a `CNAME` record to `pixeltwin.github.io`
   for a subdomain, or GitHub's `A`/`AAAA` records for an apex domain).
3. Settings → Pages → Custom domain: enter it and turn on *Enforce HTTPS*.
4. Change the absolute URLs in `index.html` that social sites need (`og:url`, `og:image`,
   `twitter:image`) and `PAGES_URL` in `scripts/site-check.ts` to the new address. Everything else is
   relative and needs no change.
