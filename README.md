# QFB POS – Restaurant Billing

A single-file restaurant billing app that runs in any modern browser, on desktop and mobile. No server and no installation.

## Open it

1. Download `restaurant-billing.html`.
2. Double-click it (Chrome or Edge recommended).
3. The first time it needs internet to load the PDF and Excel libraries.

## What it does

- **Billing** – tap menu tiles (with pictures), set quantities, add customer or company name, phone and GSTIN.
- **Invoices** – saved as PDF and printed on 2-inch (58 mm), 3-inch (80 mm) or A4 paper, with CGST/SGST, round-off and amount in words.
- **Settings** – company name, GSTIN, address, FSSAI number, seal and signature, menu items (quick add + Excel/CSV import), invoice numbering, invoice folder.
- **Reports** – daily, weekly, monthly, yearly (April–March) and custom periods, with an Excel export.
- **Customer Summary** – one summary bill PDF per customer or company for a date or period.
- **Master Excel** – `Master_Invoices.xlsx` (invoices, GST rate-wise, items) for GST filing.

## Where your data lives

Everything is stored in the browser you use (localStorage). It is **not** stored in this repository.
Use **Settings → Backup** regularly, especially before clearing browser data or changing computers.

## Invoice folder

In Chrome or Edge on a computer, choose a folder once under **Settings → Choose folder**. PDFs and `Master_Invoices.xlsx`
are then saved there automatically. On phones and other browsers, files go to the Downloads folder.

## Notes

- Assumes sales within your own state (CGST + SGST). IGST for interstate sales is not included.
- PDFs print the rupee as "Rs." because the built-in PDF font has no ₹ symbol.
- On first print, pick the matching roll size (for example 80 mm) in the print dialog.
