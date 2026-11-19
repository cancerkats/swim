import fs from "node:fs";

const TIDE_URL = "https://www.tidetime.org/europe/ireland/dun-laoghaire.htm";
const LAT = 53.2939;
const LON = -6.1359;
const TZ = "Europe/Dublin";

function getDublinDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year").value;
  const m = parts.find((p) => p.type === "month").value;
  const d = parts.find((p) => p.type === "day").value;
  return `${y}-${m}-${d}`;
}

function getDublinOffsetHours(date = new Date()) {
  const tzName = new Intl.DateTimeFormat("en-IE", {
    timeZone: TZ,
    timeZoneName: "shortOffset"
  })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName")?.value || "GMT";
  const match = tzName.match(/GMT([+-]\d+(?::\d+)?)/);
  if (!match) return 0;
  const [hStr, mStr = "0"] = match[1].split(":");
  return Number(hStr) + Math.sign(Number(hStr) || 1) * (Number(mStr) / 60);
}

function to24hMinutes(timeStr) {
  const clean = timeStr.trim().toLowerCase();
  const m = clean.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
  if (!m) return null;
  let h = Number(m[1]);
  const mins = Number(m[2]);
  const period = m[3];
  if (period === "am" && h === 12) h = 0;
  if (period === "pm" && h !== 12) h += 12;
  return h * 60 + mins;
}

function fromMinutes(totalMins) {
  const clamped = Math.max(0, Math.min(1439, Math.round(totalMins)));
  const h = String(Math.floor(clamped / 60)).padStart(2, "0");
  const m = String(clamped % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function getSunriseSunsetMinutes(dateKey, offsetHours) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const start = new Date(Date.UTC(y, 0, 1));
  const dayOfYear = Math.floor((dt - start) / 86400000) + 1;

  const rad = Math.PI / 180;
  const latRad = LAT * rad;
  const decl = 23.44 * rad * Math.sin(rad * (360 / 365) * (dayOfYear - 81));
  const cosH =
    (Math.cos(90.833 * rad) - Math.sin(latRad) * Math.sin(decl)) /
    (Math.cos(latRad) * Math.cos(decl));
  const hourAngleDeg = Math.acos(Math.max(-1, Math.min(1, cosH))) / rad;

  const solarNoonUtcMins = (12 - LON / 15) * 60;
  const halfDayMins = (hourAngleDeg / 15) * 60;
  const localShift = offsetHours * 60;

  return {
    sunrise: Math.round(solarNoonUtcMins - halfDayMins + localShift),
    sunset: Math.round(solarNoonUtcMins + halfDayMins + localShift)
  };
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTodayTides(html) {
  const text = stripTags(html);
  // Look for the "Dún Laoghaire tide today" block and grab High/Low entries before "Dún Laoghaire tide tomorrow"
  const todaySectionMatch = text.match(
    /D[úu]n Laoghaire tide today([\s\S]*?)(?:D[úu]n Laoghaire tide tomorrow|About today's tides)/i
  );
  const scope = todaySectionMatch ? todaySectionMatch[1] : text;
  const matches = [...scope.matchAll(/\b(High|Low)\s+(\d{1,2}:\d{2}\s*(?:am|pm))/gi)];

  return matches
    .map((m) => ({
      type: m[1].toLowerCase(),
      minutes: to24hMinutes(m[2]),
      label: m[2].replace(/\s+/g, "").toLowerCase()
    }))
    .filter((t) => t.minutes !== null);
}

async function main() {
  const now = new Date();
  const dateKey = getDublinDateKey(now);
  const offsetHours = getDublinOffsetHours(now);
  const sun = getSunriseSunsetMinutes(dateKey, offsetHours);

  let swimMessage = `No daylight high-tide swim window today in Dún Laoghaire (${dateKey}).`;

  try {
    const res = await fetch(TIDE_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DunLaoghaireSwimBot/1.0)" }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const tides = extractTodayTides(html);

    const highTides = tides.filter((t) => t.type === "high");
    const windows = [];

    for (const ht of highTides) {
      const start = Math.max(ht.minutes - 120, sun.sunrise);
      const end = Math.min(ht.minutes + 120, sun.sunset);
      if (start < end) {
        windows.push({
          window: `${fromMinutes(start)}–${fromMinutes(end)}`,
          highTide: fromMinutes(ht.minutes)
        });
      }
    }

    if (windows.length > 0) {
      const formatted = windows
        .map((w) => `${w.window} (high tide ${w.highTide})`)
        .join(" or ");
      swimMessage = `Dún Laoghaire swim today: ${formatted}; sunrise ${fromMinutes(sun.sunrise)}, sunset ${fromMinutes(sun.sunset)}.`;
    } else {
      swimMessage = `No daylight high-tide swim window today in Dún Laoghaire; sunrise ${fromMinutes(sun.sunrise)}, sunset ${fromMinutes(sun.sunset)}.`;
    }
  } catch (err) {
    swimMessage = `Could not refresh Dún Laoghaire tides today (${err.message}); sunrise ${fromMinutes(sun.sunrise)}, sunset ${fromMinutes(sun.sunset)}.`;
  }

  const payload = {
    location: "Dún Laoghaire",
    date: dateKey,
    updatedAt: now.toISOString(),
    swimMessage
  };

  fs.writeFileSync("swim.json", JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log("Updated swim.json:", payload.swimMessage);
}

main();
