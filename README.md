# Connext — coming-soon landing page

One page: the intro video, a short "we're building our new website" message, a notify form and a footer.
The page itself is plain HTML, CSS and JavaScript (no libraries, no tracking, no third-party requests).
A small Node server (`server.js`) serves it, and saves each sign-up in a Postgres database.

```
├── site/                      the web page (index.html, assets/css, assets/js, assets/img, assets/video)
├── server.js                  serves site/, takes the form at /api/notify, CSV export at /admin/leads.csv
├── package.json               Railway reads this: `npm start` runs the server
├── test/server.test.js        automated tests (npm test)
├── vercel.json, site/_headers only for static hosts such as Vercel, Netlify; Railway does not use them
├── Pitch Deck 1 - Connext.mp4 your original 200 MB video. Local only: git-ignored, not in the repository.
└── README.md
```

## Run it on your computer

```bash
npm install
npm run dev        # http://localhost:5195, sign-ups are kept in memory only and vanish on restart
npm test           # 18 checks: files, video seeking, security, form, rate limit, CSV export
```

## Put it live on Railway

1. **Deploy the repo.** Railway → New Project → Deploy from GitHub repo → `connext-landing-page`. It finds `package.json`
   and runs `npm start`. Nothing else to configure. Every push to `main` redeploys.
2. **Add the database.** In the same project: **+ New → Database → Add PostgreSQL**.
3. **Connect them.** Open the web service → **Variables** and add:
   - `DATABASE_URL` → choose **Add Reference** → the Postgres service → `DATABASE_URL`.
   - `ADMIN_TOKEN` → a long random password of at least 16 characters (for example the output of `openssl rand -base64 24`).
     Keep it somewhere safe; it protects your sign-ups.
4. **Test it.** Web service → **Settings → Networking → Generate Domain**, open the link, submit the form.
   In the service **Logs** you will see `signup stored`.
5. **Look at the sign-ups.** Open `https://YOUR-DOMAIN/admin/leads.csv`. The browser asks for a password: type anything as the user name
   and the `ADMIN_TOKEN` as the password. A CSV downloads (name, email, phone, role, time) that opens in Excel or Google Sheets.

The same email submitted twice updates one row instead of creating two. Names, emails and phone numbers are never written to the logs,
and visitors' IP addresses are not stored. Check Railway's backup options for your plan; until then, download the CSV now and then.

### Settings (Railway → Variables)

| Variable | Needed | What it does |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection. Without it the form answers "temporarily unavailable" (the page still works). |
| `ADMIN_TOKEN` | for the CSV | Password for `/admin/leads.csv`, 16+ characters. Without it the export is switched off. |
| `RATE_LIMIT_PER_10MIN` | no | Sign-ups allowed per visitor in 10 minutes (default 10). |
| `TRUST_PROXY_HOPS` | no | Proxies in front of the server, used to find the visitor's IP (default 1, right for Railway). |

## Your own domain (DNS stays at GoDaddy)

Railway cannot point the **bare** `connextindia.com` at itself while DNS is at GoDaddy (GoDaddy has no CNAME-at-root support). So:

1. **`www.connextindia.com` on Railway.** Web service → Settings → Networking → **Custom Domain** → `www.connextindia.com`.
   Railway shows a **CNAME** target and a **TXT** verification record. In GoDaddy → DNS, *edit* the `www` CNAME (it points to
   `sites.framer.app` today) to the Railway target and *add* the TXT record.
2. **Bare `connextindia.com` forwards to www.** In GoDaddy delete the two old Framer **A** records for `@`
   (`31.43.160.6`, `31.43.161.6`), then DNS → **Forwarding → Add → Domain** → forward to `https://www.connextindia.com`
   (permanent). Open `https://connextindia.com` afterwards to confirm it redirects without a certificate warning.
3. **Leave every other record alone** (MX, TXT for SPF/DKIM/Google, NS, `_domainconnect`): they carry the company email.
   If the domain is still attached to a Framer project, remove it there too.

When it works, replace `https://example.com` in `site/index.html` (`canonical`, `og:url`, `og:image`) with `https://www.connextindia.com`.

## Before you tell people about it

- Footer: add contact email, phone or WhatsApp, social links and app-store links when you have them. It already shows the company name,
  registered office and CIN of Locogrow Solution Pvt Ltd. Check the spelling against the incorporation certificate ("Solution" or "Solutions").
- Open the live link on a phone: the video autoplays muted, and "Play with sound" restarts it with sound.

## Hosting somewhere else

The page also works on any static host (Netlify, Cloudflare Pages, Vercel, GitHub Pages) if you upload the `site/` folder, but those
have no `/api/notify`, so the form needs another destination. In `site/assets/js/main.js` set `endpoint` to a form service URL
(for example a free Formspree form, `https://formspree.io/f/xxxxxxx`); it is sent as JSON, which Formspree accepts.
`site/_headers` (Netlify, Cloudflare Pages) and `vercel.json` carry the same security headers that `server.js` sets itself.
If you keep a static copy on GitHub Pages, its form will show an error because there is no server behind it.

## Replacing the video

Keep the source in the project folder, then encode two sizes (needs ffmpeg). `faststart` lets it begin playing before it has downloaded.

```bash
ffmpeg -i "Pitch Deck 1 - Connext.mp4" -c:v libx264 -profile:v high -crf 27 -preset slow -g 60 \
  -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart site/assets/video/connext-pitch-1080.mp4

ffmpeg -i "Pitch Deck 1 - Connext.mp4" -vf scale=-2:720 -c:v libx264 -profile:v high -crf 28 -preset slow -g 60 \
  -pix_fmt yuv420p -c:a aac -b:a 80k -movflags +faststart site/assets/video/connext-pitch-720.mp4

ffmpeg -ss 1.2 -i "Pitch Deck 1 - Connext.mp4" -frames:v 1 -vf scale=1600:-2 -q:v 6 site/assets/img/poster.jpg
```

Phones, slow connections and data-saver mode get the 720 file; everyone else gets 1080. Images and video are cached for 30 days,
so if you replace a file on a live site, give the new file a new name and update the name in `main.js` (or `index.html` for the poster).

## How it behaves

- Video starts muted (browsers only allow silent autoplay), pauses when scrolled away or the tab is hidden, resumes after.
  With "reduce motion" turned on in the visitor's system it does not autoplay.
- Keyboard: Space or K play/pause, M mute, F full screen, ← → skip 5 seconds.
- The form checks name, email and phone before sending, and the server checks them again. It has a hidden spam trap,
  a per-visitor rate limit, and keeps the card the same size when the thank-you appears.
- Works from 320 px phones to wide desktops, in portrait and landscape.
