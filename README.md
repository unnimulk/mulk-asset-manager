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
- A **Control** tab for every asset in the register. Laptops and desktops get admin rights, a one-time local Administrator password change, and a queued MSI or EXE install. Printers get a queue mode. Phones get an enrollment mark. Other assets are controlled by who holds them and whether they are on hold. The page records the decision, the public IP, and the city and country of that IP. It does not read files, capture the screen, record the keyboard, or use GPS.
- An **Alerts** page for asset admins. Enrolled computers report installed software, USB devices plugged in after the first scan, a public IP whose country is outside the UAE, and health (BitLocker, Defender, firewall, disk, serial, local administrators, startup names). A computer not seen for a day is listed. Documents are not collected.
- A **Usage** page for active hours, time in each app, and web searches (Google, Bing, DuckDuckGo, Yahoo, YouTube). Searches already in the browser before the agent starts watching are not imported. Page contents and passwords are not stored.

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
   `insert into public.app_admins (email) values ('unni@mulkholdings.com')`.
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
| Approve a request for admin rights | **Control**. When someone asks, a popup lists the person, the computer, and the reason. Approve 1 hour, 4 hours, or until 18:00 GST, or deny it. The request itself never grants admin rights |
| See a USB device | **Alerts**. Devices already plugged in at the first check are the baseline. A device plugged in after that is listed until you mark it reviewed. Files on the device are not stored |
| See a computer outside the UAE | **Alerts** and the asset page. The place is the city and country of the public IP. GPS is not used |
| See active hours, app time, and searches | **Usage**, or the asset page. Active time counts while someone is at the computer. The search log is the query text only |
| See installed software | Open the asset, or **Alerts** and choose the computer. The list is program name, version, and publisher |
| Review a new install | **Alerts**. The first scan from a computer is the baseline and is not an alert. A program installed after that stays open until you mark it reviewed |
| Download Mulk Agent | After you sign in, **Download agent** in the sidebar, or **Download Mulk Agent** on **Control**. For one computer, open it in Control and choose **Download setup for this computer** |
| Lock an asset | **Control**, open the asset, **Lock asset**, and write the reason. On a Windows laptop or desktop, nobody can sign in until you choose **Unlock asset**. Wi-Fi and Ethernet stay on so the computer keeps reaching the dashboard. Checking that asset out is refused while it is locked. A lock does not wipe the computer |
| Change a computer's local Administrator password | **Control**, open the computer, **Change local admin password**. It is applied once, then deleted from the database. The account is not enabled by this change |
| Install software on a laptop | **Control**, open the computer, **Install software**, and paste an `https://` link that ends in `.msi` or `.exe` |
| See health or a quiet computer | **Alerts**. Encryption, Defender, firewall, low disk, a serial mismatch, a banned program, and changes to local administrators or startup names are listed. A computer not seen for about a day is shown from its last check-in |

Status and assignment change only through the action buttons. That way every change appears in the history.

## Good to know

- **Security:** only signed-in users whose e-mail is on the Admins list can read or change data. This is enforced inside the database (row level security), not only in the browser. The anon key is designed to be public.
- **Free tier:** Supabase pauses a free project after about a week with no use. You can restore it with one click, and no data is lost. For daily company use, the Pro plan (~$25/month) avoids pausing and adds daily backups. Vercel's free Hobby plan is for non-commercial use, so for company use choose Vercel Pro, or host on a team account.
- **Control storage:** if that tab says shared storage is not set up, open Supabase → SQL Editor and run `supabase/laptop-control.sql` once. Until then, decisions stay in the browser you are using. A fresh run of `schema.sql` already includes these tables. Re-run the same file if the tab asks for the connection columns.
- **Mulk Agent:** the Windows program for laptops and desktops. It does not need Intune. After you sign in, download it from the sidebar, or create a code in **Control** and run the installer from `/agent/` as Administrator. Run `supabase/agent.sql` once in Supabase first (and `supabase/laptop-control.sql` if you have not), then `supabase/asset-admin.sql`, `supabase/presence.sql`, `supabase/usage.sql`, `supabase/it-admin.sql`, and `supabase/asset-lock.sql`. The person sees a window named Mulk Agent. Macs are not covered by this installer. The agent reports program names, USB device names, health, the city and country of the public IP, search text, and which app is in front. It does not read files, capture the screen, or record the keyboard.
- **Backups:** **Reports → Full asset register** downloads everything to Excel. Do this regularly if you stay on the free plan.
- **Label printers:** the Medium size fits Brother DK 62 mm tape. The Large size fits A4 sheets with 24 labels (70 × 37 mm). In the print dialog, set margins to *None* and scale to *100%*.

## Third-party code

`public/vendor/xlsx.full.min.js` is SheetJS Community Edition 0.18.5 (Apache-2.0). `public/vendor/qrcode.js` is qrcode-generator 2.0.4 by Kazuhiko Arase (MIT). Their licence files are in the same folder.
