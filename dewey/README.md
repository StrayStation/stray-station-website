# Dewey — personal book catalog (PWA)

Named for Melvil Dewey and his decimal classification system, the scheme that put every library book in its place.

Scan a barcode, read an ISBN from a photo, or search by title and author, then catalog the book with categories, a rating and a review. It runs in Safari on iPhone and Chrome on Android, installs to the home screen, and costs $0 to run.

**Stack:** vanilla HTML/CSS/JS (no build step) · Supabase free tier (database, sign-in, cover photos) · Open Library + Google Books (free lookups, no keys) · ZXing / native BarcodeDetector (scanning) · Tesseract.js (on-device text reading)

## Files

| File | What it does |
|---|---|
| `index.html`, `styles.css` | App shell and styling |
| `app.js` | Sign-in, library, add flows, book page, edit form, settings |
| `scan.js` | Camera barcode scanning (native detector on Android, ZXing on iPhone) |
| `ocr.js` | Reads text from photos on the phone; shrinks cover photos before upload |
| `lookup.js` | Open Library and Google Books lookups and search |
| `isbn.js` | ISBN validation, ISBN-10 ↔ ISBN-13 conversion, finding ISBNs in OCR text |
| `categories.js` | Starter categories and the keyword rules that suggest them |
| `config.js` | **Your Supabase URL and key go here** |
| `schema.sql` | Database tables, privacy rules and cover storage. Run once in Supabase |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable-app pieces |

## Setup (about 15 minutes)

### 1. Create the Supabase project
1. Sign up at supabase.com and create a new project (free plan). Pick a region near you, e.g. East US.
2. Open **SQL Editor → New query**, paste all of `schema.sql`, and click **Run**. It should finish with "Success. No rows returned."

### 2. Switch sign-in emails to codes
The app signs people in with a 6-digit emailed code instead of a link. Links break on iPhone because they open in Safari, not in the home-screen app.

In **Authentication → Emails → Templates**, edit both **Confirm signup** and **Magic Link** so the body contains the code, for example:

```html
<h2>Your Dewey sign-in code</h2>
<p>Enter this code in the app: <strong>{{ .Token }}</strong></p>
```

### 3. Add your keys
In **Project Settings → API** (or **API Keys**), copy the **Project URL** and the **anon** (or **publishable**) key into `config.js`. This key is meant to be public; the row-level security rules in `schema.sql` keep each person's library private. Never put the `service_role` / secret key in this app.

### 4. Deploy to StrayStation
1. Copy this folder into your StrayStation repo as `/dewey/` (so the app lives at `straystation.com/dewey/`).
2. Commit and push. Netlify deploys it as static files; no build settings needed.
3. If your site sends a Content-Security-Policy header, allow `cdn.jsdelivr.net`, `fonts.googleapis.com`, `fonts.gstatic.com`, `*.supabase.co`, `openlibrary.org`, `covers.openlibrary.org`, `archive.org`, `www.googleapis.com` and `books.google.com`.

### 5. Sign in and install
- Open `straystation.com/dewey/` on each phone and sign in with your email.
- **iPhone:** Safari → Share → **Add to Home Screen**.
- **Android:** Chrome → ⋮ menu → **Install app**.

### 6. Lock the door
Once you and your family member have signed in once, go to **Authentication → Sign In / Providers** and turn off **Allow new users to sign up**. Otherwise anyone who finds the URL could create an account in your project.

## Using it

- **Barcode:** works for most books from the mid-1980s on. If a book has a price-tag style barcode (UPC, often on mass-market paperbacks), look inside the front cover for the ISBN barcode.
- **Photo:** photograph the copyright page; the app finds the ISBN (ISBN-10s from the 1970s work too) and looks it up. With no ISBN, tap the lines that hold the title and author, then search.
- **Search:** Open Library is strongest for older and out-of-print books; results from both sources are mixed together.
- **Type it in:** for anything not found online. Add your own cover photo; books without one get a cloth-bound cover with the title in foil.
- **Search your library:** matches title, author, ISBN, publisher, year, categories, shelf location, notes and review text. Filter by status and category; sort by date added, title, author surname, rating or year.
- **Backup:** Settings → Download CSV (saved as `dewey-library-<date>.csv`).

## Free-tier facts worth knowing
- **Pausing:** Supabase pauses free projects after about a week with no activity. Your data is kept; click **Restore** in the dashboard. Regular use prevents it.
- **Email limits:** the built-in email service only sends a few sign-in emails per hour. That's fine for a household, since sessions stay signed in on each phone.
- **Storage:** cover photos are resized to about 100–200 KB each, so the 1 GB free storage holds thousands.
- **Lookups:** Open Library and Google Books are free without keys. Google may rate-limit heavy bursts; scanning a few hundred books in one session is fine.

## Updating the app
After changing files, bump `VERSION` in `sw.js` (e.g. `dewey-v2`) and deploy. Phones pick up the new version on the next launch after that (sometimes the second).

## Testing on your laptop
The camera only works over https or on `localhost`. From this folder run `python -m http.server 8000` and open `http://localhost:8000`. Phone testing needs the deployed https URL.

## Ideas for phase 2
- Jigsaw puzzles as a second item type (UPC lookup, piece count, missing pieces, completion log)
- Bulk scan mode: scan a whole shelf, review the queue afterwards
- Optional free-tier AI vision (e.g. Gemini) via a Supabase Edge Function for cover-only identification
- Shared "family shelf" view, if you ever want to see each other's libraries
