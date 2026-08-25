# Darren Ting — Portfolio

Static site. No build step.

## Publishing to GitHub Pages

1. Create a repository and upload **everything inside this folder** to the repo root
   (`index.html` must sit at the top level, not inside a subfolder).
2. **Settings → Pages** → Source: `Deploy from a branch`, branch `main`, folder `/ (root)`.
3. Add your custom domain in the same screen, then create the DNS records GitHub
   shows you at your registrar.
4. Tick **Enforce HTTPS** once the domain verifies.

## Files

- `index.html` — the whole site (home, about, three case studies)
- `support.js`, `image-slot.js` — runtime scripts, required
- `assets/` — all images, icons, stickers, and `resume.pdf`
- `.nojekyll` — stops GitHub Pages from running Jekyll over the folder

## Notes

- Navigation uses URL fragments (`#about`, `#acer`, `#uoft`, `#bmo`), so every
  page is reachable by link and deep links work with no server config.
- The clock reads the visitor's local time; the weather comes from a public API
  (open-meteo.com) with no key required.
- Light/dark follows Toronto time (light 9AM–5PM, dark 5PM–9AM) unless the
  visitor clicks the sticker.
