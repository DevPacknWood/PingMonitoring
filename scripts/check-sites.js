const { Resend } = require("resend");

// ─── Configuration ───────────────────────────────────────────────────────────

const SITES = [
  { name: "firstpack.fr", url: "https://www.firstpack.fr/" },
  { name: "laboutiquedujetable.fr", url: "https://www.laboutiquedujetable.fr/" },
  { name: "ecolomique.com", url: "https://www.ecolomique.com/" },
  { name: "nvase.es", url: "https://nvase.es/" },
  { name: "fhc-evolupack.fr", url: "https://fhc-evolupack.fr/" },
  { name: "instovi.it", url: "https://instovi.it/" },
  { name: "bioandchic.com", url: "https://bioandchic.com/" },
];

const EMAIL_FROM = "Uptime Monitor <onboarding@resend.dev>"; // TODO: Replace with your verified sender
const EMAIL_TO = "dev@groupefirstpack.com";

// ─── Vercel KV helpers (Upstash REST API) ────────────────────────────────────

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  const res = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  const data = await res.json();
  return data.result; // null if key doesn't exist
}

async function kvSet(key, value) {
  await fetch(`${KV_URL}/set/${encodeURIComponent(key)}/${value}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
}

async function kvDel(key) {
  await fetch(`${KV_URL}/del/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
}

// ─── Site checker ────────────────────────────────────────────────────────────

async function checkSite(site) {
  const start = Date.now();
  try {
    const res = await fetch(site.url, {
      signal: AbortSignal.timeout(20000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; UptimeMonitor/1.0)",
      },
    });
    const ms = Date.now() - start;
    if (res.status >= 400) {
      return { ...site, ok: false, error: `HTTP ${res.status}` };
    }
    return { ...site, ok: true, ms };
  } catch (err) {
    return { ...site, ok: false, error: err.message };
  }
}

// ─── Email senders ───────────────────────────────────────────────────────────

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendAlert(failures) {
  const rows = failures
    .map(
      (f) =>
        `<tr>
          <td style="padding:8px 12px;border:1px solid #ddd;">${f.name}</td>
          <td style="padding:8px 12px;border:1px solid #ddd;">${f.url}</td>
          <td style="padding:8px 12px;border:1px solid #ddd;color:#c0392b;">${f.error}</td>
        </tr>`
    )
    .join("");

  const html = `
    <div style="font-family:sans-serif;max-width:600px;">
      <h2 style="color:#c0392b;">⚠️ ${failures.length} site(s) en panne</h2>
      <table style="border-collapse:collapse;width:100%;">
        <thead>
          <tr style="background:#f8f8f8;">
            <th style="padding:8px 12px;border:1px solid #ddd;text-align:left;">Nom</th>
            <th style="padding:8px 12px;border:1px solid #ddd;text-align:left;">URL</th>
            <th style="padding:8px 12px;border:1px solid #ddd;text-align:left;">Erreur</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="color:#888;font-size:12px;margin-top:16px;">Check effectué le ${new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}</p>
    </div>`;

  await resend.emails.send({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject: `⚠️ ${failures.length} site(s) en panne`,
    html,
  });

  console.log(`📧 Alert email sent for ${failures.length} site(s)`);
}

async function sendRecovery(recovered) {
  const items = recovered
    .map(
      (r) =>
        `<li style="margin-bottom:8px;">
          <strong>${r.name}</strong> — <a href="${r.url}">${r.url}</a> (${r.ms}ms)
        </li>`
    )
    .join("");

  const html = `
    <div style="font-family:sans-serif;max-width:600px;">
      <h2 style="color:#27ae60;">✅ ${recovered.length} site(s) rétabli(s)</h2>
      <ul style="list-style:none;padding:0;">${items}</ul>
      <p style="color:#888;font-size:12px;margin-top:16px;">Check effectué le ${new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}</p>
    </div>`;

  await resend.emails.send({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject: `✅ ${recovered.length} site(s) rétabli(s)`,
    html,
  });

  console.log(`📧 Recovery email sent for ${recovered.length} site(s)`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`🔍 Checking ${SITES.length} site(s)...\n`);

  const results = await Promise.all(SITES.map(checkSite));

  const newFailures = [];
  const recovered = [];

  for (const result of results) {
    const kvKey = `down:${result.url}`;
    const pendingKey = `pending:${result.url}`;
    const wasDown = await kvGet(kvKey);
    const wasPending = await kvGet(pendingKey);

    if (!result.ok) {
      if (wasDown) {
        // Confirmed down, already alerted
        console.log(`⏳ STILL DOWN — ${result.name} (${result.url}): ${result.error}`);
        await kvDel(pendingKey);
      } else if (wasPending) {
        // Second consecutive failure → confirm and alert
        console.log(`❌ DOWN CONFIRMED — ${result.name} (${result.url}): ${result.error}`);
        newFailures.push(result);
        await kvSet(kvKey, "1");
        await kvDel(pendingKey);
      } else {
        // First failure → mark pending, wait for next check before alerting
        console.log(`⚠️ FIRST FAILURE (waiting confirmation) — ${result.name}: ${result.error}`);
        await kvSet(pendingKey, "1");
      }
    } else if (result.ok && wasDown) {
      // Recovered
      console.log(`✅ RECOVERED — ${result.name} (${result.url}) in ${result.ms}ms`);
      recovered.push(result);
      await kvDel(kvKey);
      await kvDel(pendingKey);
    } else {
      // All good
      if (wasPending) await kvDel(pendingKey); // transient failure resolved
      console.log(`✅ OK — ${result.name} (${result.url}) in ${result.ms}ms`);
    }
  }

  console.log("");

  if (newFailures.length > 0) {
    await sendAlert(newFailures);
  }

  if (recovered.length > 0) {
    await sendRecovery(recovered);
  }

  if (newFailures.length === 0 && recovered.length === 0) {
    console.log("No state changes — no emails sent.");
  }

  console.log("\n✔ Done.");
})();
