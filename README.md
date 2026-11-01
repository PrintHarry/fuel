# Fuel

A free, ad-free calorie, protein and weight-trend tracker that installs on your iPhone home screen. Everything is stored on the phone; nothing is sent anywhere except barcode lookups to Open Food Facts.

## Put it on your phone (one-off, about 10 minutes, £0)

1. Make a free account at github.com.
2. Click **+ → New repository**, name it `fuel`, set it to **Public**, tick **Add a README**, and create it.
3. In the new repository click **Add file → Upload files**. Drag in everything inside this `Fuel` folder (the `css`, `js`, `data` and `icons` folders plus `index.html`, `manifest.webmanifest`, `sw.js`). Click **Commit changes**.
4. Go to **Settings → Pages**. Under *Branch* choose `main` and `/ (root)`, then **Save**. After a minute the page shows your address: `https://YOUR-USERNAME.github.io/fuel/`.
5. On your iPhone, open that address in **Safari**, tap **Share → Add to Home Screen → Add**.
6. Open Fuel from the home screen icon (not from Safari) and do the setup.

## Updating it later
Upload the changed files to the repository again, and change `VERSION` at the top of `sw.js` (e.g. `fuel-v2`) so phones fetch the new version. Close and reopen the app twice to pick it up.

## Back up your data
Settings → **Export backup** and save the file to iCloud Drive. **Restore backup** brings it back on a new phone. Deleting the home-screen app deletes its data, so export first.

## Test on this PC
```
powershell -ExecutionPolicy Bypass -File serve.ps1
```
Then open http://localhost:8787.

## How it works
| File | What it does |
|---|---|
| `js/calc.js` | All the maths: Mifflin-St Jeor, targets, trend weight, adaptive expenditure, streaks |
| `js/food.js` | Food search over the bundled UK CoFID data, Open Food Facts barcode lookup |
| `js/app.js` | Screens and navigation |
| `js/db.js` | Storage on the phone (IndexedDB) and backup/restore |
| `js/charts.js` | The weight and calorie charts |
| `js/scan.js` | Camera barcode scanning |
| `sw.js` | Makes it work offline |
| `data/cofid.json` | 2,854 UK foods per 100 g, converted from the 2021 CoFID spreadsheet |

## Credits
- Generic foods: McCance and Widdowson's Composition of Foods Integrated Dataset 2021, Public Health England, Open Government Licence v3.0.
- Branded products: Open Food Facts, Open Database Licence.
- Barcode scanning on iPhone: `barcode-detector` (ZXing, MIT).
- Trend weight: The Hacker's Diet, John Walker.
