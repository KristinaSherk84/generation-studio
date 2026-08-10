/**
 * GET /api/admin/arm   (2026-08-10)
 *
 * One-time-per-device setup so Kristi never has to append her password to a
 * resume link on her phone. She opens this page once on a device, types her
 * admin password, taps "Arm this device" — it's verified via
 * /api/admin/verify-fix and then remembered in THIS browser's localStorage
 * (same origin as the app at /). From then on, any "ready to view" resume
 * link she opens on that device turns on admin fix mode automatically (2
 * identity regens, saved to the grid, separate from the customer's budget).
 * "Forget this device" clears it.
 *
 * No secret is baked into this page; the password is only checked server-side.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

export const maxDuration = 5;

export default async function handler(
  _req: VercelRequest,
  res: VercelResponse,
) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Arm this device — admin fix mode</title>
</head>
<body style="font:16px/1.5 -apple-system,system-ui,sans-serif;color:#2C2C2A;max-width:520px;margin:0 auto;padding:40px 22px;background:#F6F5F2">
  <h2 style="margin:0 0 6px">Admin fix mode</h2>
  <p style="color:#6b6b66;margin:0 0 22px">Arm this phone or laptop once. After that, any "ready to view" link you open on it lets you do 2 identity regens that save to the customer's grid — no password needed again on this device.</p>

  <div id="status" style="padding:12px 14px;border-radius:10px;font-weight:600;margin-bottom:18px"></div>

  <label style="display:block;font-size:13px;font-weight:600;margin-bottom:6px">Admin password</label>
  <input id="pw" type="password" autocomplete="current-password" placeholder="your admin password"
    style="width:100%;box-sizing:border-box;padding:13px 14px;font-size:16px;border:1px solid #d9d7d2;border-radius:10px;margin-bottom:14px">

  <button id="arm" style="width:100%;padding:14px;font-size:16px;font-weight:600;color:#fff;background:#2C2C2A;border:0;border-radius:10px;cursor:pointer">Arm this device</button>
  <button id="disarm" style="width:100%;padding:12px;font-size:14px;color:#7A1F1B;background:transparent;border:0;margin-top:10px;cursor:pointer;text-decoration:underline">Forget this device</button>

  <p id="msg" style="min-height:20px;font-size:14px;margin-top:14px"></p>

<script>
  var KEY = "gen_admin_fix_pw";
  var statusEl = document.getElementById("status");
  var msgEl = document.getElementById("msg");
  function render(){
    var armed = false;
    try { armed = !!localStorage.getItem(KEY); } catch(e){}
    if (armed){
      statusEl.textContent = "This device IS armed ✅";
      statusEl.style.background = "#E5F3EA"; statusEl.style.color = "#1B6E3C";
    } else {
      statusEl.textContent = "This device is not armed yet";
      statusEl.style.background = "#EFEEEA"; statusEl.style.color = "#6b6b66";
    }
  }
  document.getElementById("arm").onclick = function(){
    var pw = document.getElementById("pw").value || "";
    if (!pw){ msgEl.style.color="#7A1F1B"; msgEl.textContent="Enter your password first."; return; }
    msgEl.style.color="#6b6b66"; msgEl.textContent="Checking…";
    fetch("/api/admin/verify-fix",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pw:pw})})
      .then(function(r){ return r.ok; })
      .then(function(ok){
        if (ok){
          try { localStorage.setItem(KEY, pw); } catch(e){}
          document.getElementById("pw").value="";
          msgEl.style.color="#1B6E3C"; msgEl.textContent="Done — this device is armed. Open any 'ready to view' link and you'll see the green fix-mode badge.";
        } else {
          msgEl.style.color="#7A1F1B"; msgEl.textContent="That password didn't match. Try again.";
        }
        render();
      })
      .catch(function(){ msgEl.style.color="#7A1F1B"; msgEl.textContent="Network error — try again."; });
  };
  document.getElementById("disarm").onclick = function(){
    try { localStorage.removeItem(KEY); } catch(e){}
    msgEl.style.color="#6b6b66"; msgEl.textContent="This device has been forgotten. Resume links now behave normally.";
    render();
  };
  render();
</script>
</body></html>`);
}
