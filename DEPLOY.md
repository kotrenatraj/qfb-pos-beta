# Running QFB POS on a server (shared data on every device)

## 1. One-time setup (Ubuntu, e.g. Oracle Cloud Always Free)
```
sudo apt update && sudo apt install -y nodejs git
sudo useradd -r -m qfb
sudo git clone https://github.com/kotrenatraj/qfb-pos-beta /opt/qfb-pos
sudo mkdir -p /var/lib/qfb-pos && sudo chown qfb /var/lib/qfb-pos
sudo cp /opt/qfb-pos/.env.example /etc/qfb-pos.env && sudo chmod 600 /etc/qfb-pos.env
sudo nano /etc/qfb-pos.env          # set QFB_PASSWORD
sudo cp /opt/qfb-pos/qfb-pos.service /etc/systemd/system/
sudo systemctl enable --now qfb-pos
```
Node 18 or newer is required. No `npm install` is needed.

## 2. HTTPS (pick one)
- **Tailscale (simplest, private):** install Tailscale on the server and every device, then run
  `sudo tailscale serve --bg 3000` and open the `https://<machine>.<tailnet>.ts.net` address.
  Nothing is exposed to the public internet.
- **Public with Caddy:** point a domain at the server, install Caddy, and use
  `yourdomain.com { reverse_proxy 127.0.0.1:3000 }`. Set `TRUST_PROXY=1`. Open ports 80 and 443 only.

On Oracle Cloud also open the ports in the VCN security list, not just the OS firewall.

## 3. Data and backups
- All data is in `DATA_DIR` (`state.json`/invoice shards, `files/` for PDFs and Excel).
- A daily copy goes to `DATA_DIR/backups` (last 30 days). Also copy `DATA_DIR` off the machine regularly
  (for example `rsync` or an Oracle block-volume backup). Settings has a Backup button too.
- Browse saved PDFs and the master Excel at `/files` after signing in.

## 4. Updating
`cd /opt/qfb-pos && sudo git pull && sudo systemctl restart qfb-pos`

## 5. Behaviour to know
- Every change is saved to the server at once; other devices see it within about 5 seconds.
- If the server cannot be reached, the app says so and the last change is NOT saved. It never quietly
  stores data on one device only. Retry once the connection returns.
- Editing the same bill on two devices: the second save is refused and the latest version is loaded.
- The server issues invoice and summary numbers, so numbers never repeat across devices.
- Existing data from the single-device version: use Backup on that device, then Restore on the server version.

## 6. Automatic alerts for edited or cancelled bills (free)
A browser cannot send WhatsApp silently, and Meta's official WhatsApp API is paid, so the server can send alerts through
two free channels. Set up one or both in `/etc/qfb-pos.env`, then `sudo systemctl restart qfb-pos`.

**A. Telegram bot (free, official, most reliable)**
1. In Telegram, open **@BotFather**, send `/newbot`, follow the prompts, and copy the token. Set `TG_TOKEN=`.
2. Open your new bot and press Start (send it any message). The owner does this from the phone that should get alerts.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and find `"chat":{"id":NUMBER`. Set `TG_CHAT=NUMBER`.
   (For a group, add the bot to the group and use the group's negative id.)

**B. WhatsApp through CallMeBot (free, unofficial)**
1. From the owner's phone, save the CallMeBot contact and send it the activation message, following https://www.callmebot.com/blog/free-api-whatsapp-messages/
   (the current number and wording are on that page). It replies with an API key. Set `CMB_KEY=` and, if the owner's number differs
   from the Alert number in Settings, `CMB_PHONE=91XXXXXXXXXX`.
2. Caveats: CallMeBot is a third-party hobby service. Message text passes through it, it can only message the number that activated it,
   and it may be slow or unavailable. Use Telegram if you need dependable delivery.

If every channel fails, the app shows the manual WhatsApp and SMS buttons.
