# Connext — coming-soon landing page

One page: the intro video, a short "we're building our new website" message, a notify form and a footer.
Plain HTML, CSS and JavaScript. No libraries, no build step, no tracking, no third-party requests.

```
landingpage/
├── site/                      ← deploy THIS folder, and only this folder
│   ├── index.html
│   ├── assets/css/style.css
│   ├── assets/js/main.js      ← form settings live at the top of this file
│   ├── assets/img/            ← logos, poster, favicons, share image
│   ├── assets/video/          ← connext-pitch-1080.mp4 (16 MB) and -720.mp4 (8 MB)
│   ├── _headers               ← security and cache headers (Netlify, Cloudflare Pages)
│   └── robots.txt
├── preview.py                 ← run it on your computer
├── Pitch Deck 1 - Connext.mp4 ← your original 200 MB video. Local only: it is git-ignored, so it is not in the repository.
└── README.md
```

## See it on your computer

```bash
python3 preview.py
```

Open http://localhost:5190. (Python's plain `http.server` can't scrub through a video, which is why `preview.py` exists.)

## Before you go live (5 things)

1. **Connect the form.** It is not connected yet. On your computer it only pretends to succeed; on a live site it
   shows an error instead of fake success. In `site/assets/js/main.js` set one of:
   - `endpoint` — a form service. Easiest: create a free form at formspree.io, copy its URL
     (`https://formspree.io/f/xxxxxxx`) and paste it in. Submissions arrive in your email.
     Netlify Forms and any API that accepts a normal form post also work.
   - `email` — if there is no endpoint, the visitor's mail app opens with the message ready. Less smooth, but it works.
2. **Replace `https://example.com`** with your real domain in `site/index.html`: the `canonical`, `og:url` and
   `og:image` lines (marked `EDIT BEFORE LAUNCH`). This is what WhatsApp, LinkedIn and Google show when the link is shared.
3. **Add contact details** in the footer of `index.html` (email, phone or WhatsApp, social links, app-store links)
   when you have them. The footer already shows the company name, registered office and CIN of Locogrow Solution Pvt Ltd,
   plus a link to the form. Check the company name spelling against the incorporation certificate ("Solution" or "Solutions").
4. **Tighten the CSP (optional).** In `site/_headers`, `connect-src` and `form-action` allow any `https:` address so the form
   works with whichever service you pick. Once chosen, replace `https:` with just that host, for example `https://formspree.io`.
5. **Check the live link** on a phone: the video autoplays muted, tapping "Play with sound" restarts it with sound.

## Deploy

Upload the **`site`** folder. Nothing to build.

- **Netlify**: drag `site` onto app.netlify.com/drop.
- **Cloudflare Pages**: Create project → Direct upload → choose `site`.
- **Vercel**: `cd site && npx vercel --prod`. Vercel ignores `_headers`; copy the same headers into a `vercel.json`.
- **Any other host** (nginx, S3 + CloudFront, shared hosting): upload the folder contents to the web root, and make sure
  the server answers video byte-range requests (nearly all do) and sends the headers in `_headers`.

## Replacing the video

Keep the source in `landingpage/`, then encode two sizes (needs ffmpeg). `faststart` lets it begin playing before it has downloaded.

```bash
ffmpeg -i "Pitch Deck 1 - Connext.mp4" -c:v libx264 -profile:v high -crf 27 -preset slow -g 60 \
  -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart site/assets/video/connext-pitch-1080.mp4

ffmpeg -i "Pitch Deck 1 - Connext.mp4" -vf scale=-2:720 -c:v libx264 -profile:v high -crf 28 -preset slow -g 60 \
  -pix_fmt yuv420p -c:a aac -b:a 80k -movflags +faststart site/assets/video/connext-pitch-720.mp4

ffmpeg -ss 1.2 -i "Pitch Deck 1 - Connext.mp4" -frames:v 1 -vf scale=1600:-2 -q:v 6 site/assets/img/poster.jpg
```

Phones, slow connections and data-saver mode get the 720 file; everyone else gets 1080. Images and video are cached for
30 days, so if you replace a file on a live site, give the new file a new name and update the name in `main.js` (or `index.html` for the poster).

## How it behaves

- Video starts muted (browsers only allow silent autoplay), pauses when scrolled away or the tab is hidden, resumes after.
  With "reduce motion" turned on in the visitor's system it does not autoplay.
- Keyboard: Space or K play/pause, M mute, F full screen, ← → skip 5 seconds.
- The form checks name, email and phone before sending, has a hidden spam trap, and keeps the card the same size when the thank-you appears.
- Works from 320 px phones to wide desktops, in portrait and landscape.
