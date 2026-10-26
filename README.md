# Mulk IT Asset Manager

A replacement for AssetTiger: a web app hosted on **Vercel** that stores its data in **Supabase**.

**What it does**
- An asset register with search and filters (status, category, site, department and location), plus Excel export
- Check-out and check-in to employees, with a complete history for every asset
- Repairs (vendor and cost), broken, lost, disposal (method and sale value) and restore
- QR labels in three sizes. Scanning a label with a phone camera opens that asset's page
- Imports the AssetTiger Excel export directly. You can re-import at any time: rows are matched on Asset Tag ID
- Reports in Excel: full register, assets by employee, department summary, category × status, repairs and disposals, and activity for a date range
- An employee lookup, useful when someone joins or leaves
- Login for IT admins only, with an allow-list you manage on the **Admins** page

There is no build step. The project is plain HTML/JS, and all libraries are included in `public/vendor`.

```
api/config.js        Vercel function that passes your Supabase settings to the browser
public/              the web app (index.html, css, js, vendor libraries)
supabase/schema.sql  database tables, security rules and functions. Run this once in Supabase
vercel.json          tells Vercel to serve the public/ folder
```

---

## 1. Create the Supabase database (about 10 minutes)

1. Go to **https://supabase.com** and sign up. Then click **New project**.
   - Name: `mulk-assets`. Pick a strong database password and save it.
   - Region: **Mumbai (ap-south-1)** is the closest to the UAE.
2. Open **SQL Editor → New query**.
3. Open `supabase/schema.sql`. Near the top, find the line
   `insert into public.app_admins (email) values ('unni@mulkholdings.com')`
   and add any other IT admin e-mails, separated by commas, e.g. `('unni@mulkholdings.com'), ('it@mulkholdings.com')`.
4. Paste the whole file into the editor and click **Run**. You should see "Success. No rows returned".
5. **Turn off public sign-up.** Go to **Authentication → Sign In / Providers** and switch off **Allow new users to sign up**. Keep the Email provider switched on.
6. **Create your own login.** Go to **Authentication → Users → Add user → Create new user**. Enter your e-mail and a password, and tick **Auto Confirm User**.
7. **Copy the keys.** Go to **Project Settings → API** (or **Data API / API Keys**) and copy:
   - **Project URL**, which looks like `https://abcdxyz.supabase.co`
   - the **anon / public** key. A new-style **publishable** key (`sb_publishable_…`) also works.

   Never use the `service_role` or **secret** key in this app.

## 2. Deploy on Vercel (about 5 minutes)

**Option A: through GitHub (recommended, because later updates deploy automatically)**
1. Create a new **private** repository on GitHub, e.g. `mulk-asset-manager`.
2. Upload the contents of this folder: **Add file → Upload files**, then drag in everything (`api`, `public`, `supabase`, `vercel.json`, `README.md`) and click Commit.
3. In Vercel, click **Add New… → Project** and import that repository.
   - Framework Preset: **Other**
   - Leave Build Command and Output Directory empty, because `vercel.json` handles them.
4. Open **Environment Variables** and add:
   | Name | Value |
   |---|---|
   | `SUPABASE_URL` | your Project URL |
   | `SUPABASE_ANON_KEY` | your anon / publishable key |
   | `COMPANY_NAME` | `Mulk Holdings` (optional; it is printed on the labels) |
5. Click **Deploy**.

**Option B: Vercel CLI.** Run `npx vercel` in this folder, add the same three environment variables in the dashboard, then run `npx vercel --prod`.

**Optional custom domain:** in Vercel, go to **Project → Settings → Domains** and add e.g. `assets.mulkholdings.com`.

## 3. Finish the Supabase settings

Open **Supabase → Authentication → URL Configuration**:
- **Site URL:** your Vercel address, e.g. `https://mulk-asset-manager.vercel.app` (or your custom domain)
- **Redirect URLs:** add the same address followed by `/**`

Invitation and password-reset e-mails need this to open your app.

## 4. Load your AssetTiger data

1. In AssetTiger, export **all** assets to Excel (the same kind of report as the sample).
2. Open the app, sign in, and go to **Import**. Choose the file, check the preview, then click **Import**.
3. Your AssetTiger export has two different laptops that both use the tag `MH/LAP/018/HFZ/018`. The importer keeps both and names the second one `MH/LAP/018/HFZ/018-2`. To correct it, open that asset, click **Edit** and give it a new tag.

You can run the import again whenever you like while both systems are in use. Existing tags are updated rather than duplicated.

---

## Day-to-day use

| Task | Where |
|---|---|
| Give a laptop to a new joiner | Asset page → **Check out** → enter name and department |
| Employee leaves | **Reports → Employee lookup** to see their items, then **Check in** each one |
| Laptop goes for repair | **Send for repair** (vendor and estimated cost). When it comes back, **Repair complete**. It returns to the same person automatically |
| Scrap or sell an old device | **Dispose** (method and value). The record and its history are kept |
| Add a new purchase | **Add asset** → **Suggest** fills the next tag in your numbering pattern (e.g. `MH/LAP/2026/HZF/114`) |
| Print stickers | Tick assets on the **Assets** page → **Print QR labels**, or use the **QR labels** page |
| Add another IT admin | **Admins → Add admin**, then in Supabase: **Authentication → Users → Add user → Send invitation** |

Status and assignment change only through the action buttons. That way every change appears in the history.

## Good to know

- **Security:** only signed-in users whose e-mail is on the Admins list can read or change data. This is enforced inside the database (row level security), not only in the browser. The anon key is designed to be public.
- **Free tier:** Supabase pauses a free project after about a week with no use. You can restore it with one click, and no data is lost. For daily company use, the Pro plan (~$25/month) avoids pausing and adds daily backups. Vercel's free Hobby plan is for non-commercial use, so for company use choose Vercel Pro, or host on a team account.
- **Backups:** **Reports → Full asset register** downloads everything to Excel. Do this regularly if you stay on the free plan.
- **Label printers:** the Medium size fits Brother DK 62 mm tape. The Large size fits A4 sheets with 24 labels (70 × 37 mm). In the print dialog, set margins to *None* and scale to *100%*.

## Third-party code

`public/vendor/xlsx.full.min.js` is SheetJS Community Edition 0.18.5 (Apache-2.0). `public/vendor/qrcode.js` is qrcode-generator 2.0.4 by Kazuhiko Arase (MIT). Their licence files are in the same folder.
