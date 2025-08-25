// Version 1.0 — Wake-up helper (configurable filters + post-wake validation)
// -------------------------------------------------------------------
// • CONFIG at the top: include/exclude by name (regex), device class, and transport (ZIGBEE/ZWAVE/...)
// • Default transport filter = ["zigbee"] (i.e., Zigbee-only). Set [] to allow all.
// • Uses global `args` (HomeyScript). Accepts: "30m 3s", "30m,3s", "[30m,3s]".
// • Threshold: default unit = minutes (e.g., "30" => 30m). Default = 600m (10h).
// • Validation delay: default unit = seconds (e.g., "5" => 5s). Default = 5s.
// • Classifies devices by staleness (lastUpdated vs threshold).
// • WAKE for lights only: “poke” onoff with current value (noop) to refresh.
// • Post-wake validation after delay with a fresh getDevices() pass.
// • Timestamps in Europe/Prague. Per-device age printed in minutes.
// • Summary + tags shown in MINUTES/SECONDS (no ms in logs/tags).
//
// Tags (non-breaking):
//   DevicesNotReporting          → CSV list
//   ReportingCount               → number of NOK devices
//   WokenAttempted               → number of poke attempts
//   WokenSucceeded               → number of successful pokes
//   ThresholdMinutes             → integer minutes
//   ValidationDelaySeconds       → integer seconds
//
// Usage examples (args):
//   (no args)          → threshold=600m, delay=5s
//   ["2h"]             → threshold=2h,   delay=5s
//   ["45m","8"]        → threshold=45m,  delay=8s
//   ["30m,3s"]         → threshold=30m,  delay=3s
//   ["[30m,3s]"]       → threshold=30m,  delay=3s
//
// CONFIG examples (edit below):
//   • Include ZIGBEE + ZWAVE:      includeTransports: ["zigbee","zwave"]
//   • All transports:              includeTransports: []
//   • Include smart sockets too:   remove "socket" from excludeClasses
//   • Include PCs/plugs by name:   add patterns into includeNamePatterns, e.g. "^pc", "plug"
//   • Exclude seasonal/groups:     keep patterns like "Christma", "group", etc.
// -------------------------------------------------------------------

// ────────────────────────────────────────────────────────────────────
// CONFIG — tweak to taste
// ────────────────────────────────────────────────────────────────────
const CONFIG = {
  // Transport filter: set [] to allow all. Typical values: "zigbee", "zwave", "ble", "wifi", "infrared", "rf433", "rf868"
  includeTransports: ["zigbee"], // default: Zigbee-only

  // Classes
  includeClasses: ["light"], // which real/virtual classes are "in"
  excludeClasses: ["sensor", "button", "remote", "socket", "other", "curtain", "blind", "valve", "thermostat", "fan", "lock"],

  // Names (case-insensitive regex strings)
  // IMPORTANT: leave this empty [] unless you intentionally want to include *non-lights* by name (e.g., "^pc", "plug")
  includeNamePatterns: [], 

  // Always exclude these names
  excludeNamePatterns: ["Unif", "Christma", "group"],

  // Behavior flags
  verboseSkipLogs: false,

  // Apply class exclusions *even if* the device advertises virtualClass "light"
  alwaysApplyClassExclusions: true,

  // Consider virtualClass when checking includeClasses (set false to only trust real device.class)
  treatVirtualClassAsClass: true,
};

function compileRegexList(list) {
  const out = [];
  for (const p of list || []) {
    const s = String(p || "").trim();
    if (!s) continue; // ignore empty strings (prevents match-all)
    try {
      out.push(new RegExp(s, "i"));
    } catch (e) {
      console.log(`CONFIG: bad regex "${s}": ${e.message}`);
    }
  }
  return out;
}

// Precompile regex lists
const RX_INCLUDE_NAME = compileRegexList(CONFIG.includeNamePatterns);
const RX_EXCLUDE_NAME = compileRegexList(CONFIG.excludeNamePatterns);

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────
async function wakeupDevices() {
  // Read & normalize args
  const rawArgs = typeof args !== "undefined" && Array.isArray(args) ? args.slice() : [];
  const scriptArgs =
    rawArgs.length === 1
      ? String(rawArgs[0])
          .trim()
          .replace(/^\[|\]$/g, "")
          .split(/[,\s]+/)
          .filter(Boolean)
      : rawArgs;

  // Duration parsing (per-field default units)
  function parseDurationToMs(input, { defaultUnit = "m", defaultMs = 0 } = {}) {
    if (input == null || input === "") return defaultMs;
    const raw = String(input).trim().toLowerCase();
    const m = raw.match(/^(\d+(?:\.\d+)?)([smhd])?$/);
    if (!m) {
      const n = Number(raw);
      if (Number.isFinite(n)) return applyUnit(n, defaultUnit);
      return defaultMs;
    }
    const value = Number(m[1]);
    const unit = m[2] || defaultUnit;
    return applyUnit(value, unit);

    function applyUnit(val, u) {
      switch (u) {
        case "s":
          return val * 1000;
        case "m":
          return val * 60 * 1000;
        case "h":
          return val * 60 * 60 * 1000;
        case "d":
          return val * 24 * 60 * 60 * 1000;
        default:
          return defaultMs;
      }
    }
  }

  const thresholdInMillis = parseDurationToMs(scriptArgs[0], { defaultUnit: "m", defaultMs: 600 * 60 * 1000 }); // 10h
  const validationDelayMs = parseDurationToMs(scriptArgs[1], { defaultUnit: "s", defaultMs: 5 * 1000 }); // 5s
  const thresholdMin = Math.round(thresholdInMillis / 60000);
  const validationDelaySec = Math.round(validationDelayMs / 1000);

  // Helpers
  async function safeSleep(ms) {
    const hasNodeTimer = typeof setTimeout === "function";
    const hasHomeyTimer = typeof Homey !== "undefined" && typeof Homey.setTimeout === "function";
    if (hasNodeTimer) return new Promise((resolve) => setTimeout(resolve, ms));
    if (hasHomeyTimer) return new Promise((resolve) => Homey.setTimeout(resolve, ms));
    console.log("Validation: timer API not available in this environment → skipping wait.");
    return Promise.resolve();
  }

  function formatDateSafe(input) {
    const d = input instanceof Date ? input : new Date(input);
    const t = d.getTime();
    if (Number.isNaN(t)) return "—";
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Prague",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
    const DD = get("day").padStart(2, "0");
    const MM = get("month").padStart(2, "0");
    const YYYY = get("year");
    const HH = get("hour").padStart(2, "0");
    const mm = get("minute").padStart(2, "0");
    const ss = get("second").padStart(2, "0");
    return `${DD}-${MM}-${YYYY}, ${HH}:${mm}:${ss}`;
  }

  function mostRecentCapabilityTs(capabilitiesObj) {
    let mostRecentTs = NaN;
    let mostRecentIso = null;
    for (const cap of Object.values(capabilitiesObj || {})) {
      const iso = cap?.lastUpdated;
      if (!iso) continue;
      const ts = new Date(iso).getTime();
      if (Number.isNaN(ts)) continue;
      if (Number.isNaN(mostRecentTs) || ts > mostRecentTs) {
        mostRecentTs = ts;
        mostRecentIso = iso;
      }
    }
    return { mostRecentTs, mostRecentIso };
  }

  // Transport detection (flags + heuristics)
  function detectTransports(device) {
    const set = new Set();
    const add = (v) => v && set.add(String(v).toLowerCase());

    // 1) flags (best source)
    for (const f of device.flags || []) {
      const fl = String(f).toLowerCase();
      if (/zigbee/.test(fl)) add("zigbee");
      if (/zwave/.test(fl)) add("zwave");
      if (/ble|bluetooth/.test(fl)) add("ble");
      if (/wifi|wi-?fi/.test(fl)) add("wifi");
      if (/infrared|ir/.test(fl)) add("infrared");
      if (/433/.test(fl)) add("rf433");
      if (/868/.test(fl)) add("rf868");
    }

    // 2) driver URI hints
    const uri = (device.driverUri || device.driverId || "").toLowerCase();
    if (/zigbee/.test(uri)) add("zigbee");
    if (/zwave/.test(uri)) add("zwave");

    // 3) settings prefixes (zb_* / zw_*)
    const s = device.settings || {};
    for (const k of Object.keys(s)) {
      if (/^zb[_-]/i.test(k)) add("zigbee");
      if (/^zw[_-]/i.test(k)) add("zwave");
    }

    return Array.from(set);
  }

  function transportAllowed(device) {
    const want = (CONFIG.includeTransports || []).map((x) => String(x).toLowerCase());
    if (want.length === 0) return true; // allow all
    const have = detectTransports(device);
    return have.some((t) => want.includes(t));
  }

  function classIs(device, cls, { treatVirtual = true } = {}) {
    return device.class === cls || (treatVirtual && device.virtualClass === cls);
  }

  function nameMatchesAny(name, regexList) {
    return regexList.length > 0 && regexList.some((rx) => rx.test(name));
  }

  function isIncludedByConfig(device) {
    if (!device) return { ok: false, reason: "no-device" };

    const name = device.name || "";
    const transportsWanted = (CONFIG.includeTransports || []).map((x) => String(x).toLowerCase());

    // Transport filter
    if (transportsWanted.length > 0 && !transportAllowed(device)) {
      if (CONFIG.verboseSkipLogs) console.log(`SKIP: ${name} - ${device.class} (transport)`, detectTransports(device));
      return { ok: false, reason: "transport" };
    }

    // Class inclusion
    const treatVirtual = !!CONFIG.treatVirtualClassAsClass;
    const includeByClass = CONFIG.includeClasses.some((cls) => classIs(device, cls, { treatVirtual }));

    // Name inclusion (ONLY if patterns are provided)
    const includeByName = nameMatchesAny(name, RX_INCLUDE_NAME);

    // Candidate if either rule matches
    const candidate = includeByClass || includeByName;
    if (!candidate) {
      if (CONFIG.verboseSkipLogs) console.log(`SKIP: ${name} - ${device.class} (not matching include rules)`);
      return { ok: false, reason: "not-included" };
    }

    // Name exclusions (always)
    if (nameMatchesAny(name, RX_EXCLUDE_NAME)) {
      if (CONFIG.verboseSkipLogs) console.log(`SKIP: ${name} - ${device.class} (excluded by name)`);
      return { ok: false, reason: "name-excluded" };
    }

    // Class exclusions (optionally override virtualClass "light")
    if (CONFIG.alwaysApplyClassExclusions && CONFIG.excludeClasses.includes(device.class)) {
      if (CONFIG.verboseSkipLogs) console.log(`SKIP: ${name} - ${device.class} (class-excluded)`);
      return { ok: false, reason: "class-excluded" };
    }

    return { ok: true, reason: "included" };
  }

  function classify(device, now, thresholdMs) {
    const { mostRecentTs, mostRecentIso } = mostRecentCapabilityTs(device.capabilitiesObj);
    const timeSinceUpdate = Number.isNaN(mostRecentTs) ? Infinity : now - mostRecentTs;
    const minutesSince = Number.isFinite(timeSinceUpdate) ? (timeSinceUpdate / 60000).toFixed(2) : "∞";
    const lastStr = formatDateSafe(mostRecentIso);
    const isLight = classIs(device, "light");
    const hasOnoff = !!(device.capabilitiesObj && device.capabilitiesObj["onoff"]);
    const isStale = timeSinceUpdate > thresholdMs;
    const isUnknown = !Number.isFinite(timeSinceUpdate);
    return { isStale, isUnknown, isLight, hasOnoff, minutesSince, lastStr };
  }

  // ────────────────────────────────────────────────────────────────────
  // Run
  // ────────────────────────────────────────────────────────────────────
  console.log("CONFIG:", {
    includeTransports: CONFIG.includeTransports,
    includeClasses: CONFIG.includeClasses,
    excludeClasses: CONFIG.excludeClasses,
    includeNamePatterns: CONFIG.includeNamePatterns,
    excludeNamePatterns: CONFIG.excludeNamePatterns,
    verboseSkipLogs: CONFIG.verboseSkipLogs,
  });

  const DevicesNotReporting = [];
  const devices = await Homey.devices.getDevices();
  const now = Date.now();

  let okCount = 0;
  let nokCount = 0;
  let wokenAttempted = 0;
  let wokenSucceeded = 0;

  const wakePromises = [];
  const nokCandidates = [];
  const wokenIds = new Set();

  for (const device of Object.values(devices)) {
    const inc = isIncludedByConfig(device);
    if (!inc.ok) continue;

    const info = classify(device, now, thresholdInMillis);

    if (info.isStale || info.isUnknown) {
      const reason = info.isUnknown ? "unknown lastUpdated" : `threshold ${thresholdMin}m`;
      console.log(`NOK: ${device.name} - ${device.class} [${info.minutesSince}m] (Last: ${info.lastStr}; Reason: ${reason})`);

      if (info.isLight && info.hasOnoff) {
        const currentVal = !!device.capabilitiesObj["onoff"].value;
        console.log(`WAKE try: ${device.name} → set onoff=${currentVal} (noop poke)`);
        wokenAttempted++;
        wokenIds.add(device.id);
        wakePromises.push(
          device
            .setCapabilityValue("onoff", currentVal)
            .then(() => {
              console.log(`WAKE ok: ${device.name}`);
              wokenSucceeded++;
            })
            .catch((err) => {
              console.log(`WAKE fail: ${device.name} (${err?.message || err})`);
            })
        );
      }

      DevicesNotReporting.push(`${device.name} [${info.minutesSince}m] (Last: ${info.lastStr})`);
      nokCount++;
      nokCandidates.push({ id: device.id, name: device.name });
    } else {
      console.log(`OK:  ${device.name} - ${device.class} [${info.minutesSince}m] (Last: ${info.lastStr})`);
      okCount++;
    }
  }

  await Promise.all(wakePromises);

  // Post-wake validation
  if (nokCandidates.length > 0) {
    if (validationDelayMs > 0) {
      console.log(`Validation: waiting ${validationDelaySec}s for capability updates…`);
      await safeSleep(validationDelayMs);
    }

    const refreshed = await Homey.devices.getDevices();
    const byId = new Map(Object.values(refreshed).map((d) => [d.id, d]));
    const stillFailed = [];

    for (const cand of nokCandidates) {
      const d2 = byId.get(cand.id);
      if (!d2) {
        stillFailed.push(cand);
        continue;
      }

      const info2 = classify(d2, Date.now(), thresholdInMillis);
      if (info2.isStale || info2.isUnknown) {
        stillFailed.push(cand);
      } else {
        const afterWake = wokenIds.has(cand.id) ? " (after WAKE)" : "";
        console.log(`RECOVERED: ${d2.name}${afterWake} [${info2.minutesSince}m] (Last: ${info2.lastStr})`);
      }
    }

    const recoveredCount = nokCandidates.length - stillFailed.length;
    if (recoveredCount > 0) {
      nokCount -= recoveredCount;
      const now3 = Date.now();
      const freshFailedLines = [];
      for (const f of stillFailed) {
        const d3 = byId.get(f.id);
        if (!d3) {
          freshFailedLines.push(`${f.name} [unknown] (Last: —)`);
          continue;
        }
        const i3 = classify(d3, now3, thresholdInMillis);
        freshFailedLines.push(`${d3.name} [${i3.minutesSince}m] (Last: ${i3.lastStr})`);
      }
      DevicesNotReporting.length = 0;
      DevicesNotReporting.push(...freshFailedLines);
    }
  }

  // Summary (minutes/seconds only) + tags
  console.log("---------------------------------------------");
  console.log(`Summary (threshold ${thresholdMin} minutes; validation ${validationDelaySec} seconds):`);
  console.log(`OK devices:         ${okCount}`);
  console.log(`NOK devices:        ${nokCount}`);
  console.log(`WAKE attempted:     ${wokenAttempted}`);
  console.log(`WAKE succeeded:     ${wokenSucceeded}`);
  console.log(`Failed devices list: ${DevicesNotReporting.length ? DevicesNotReporting.join(", ") : "(none)"}`);

  await tag("DevicesNotReporting", DevicesNotReporting.join(", "));
  await tag("ReportingCount", nokCount);
  await tag("WokenAttempted", wokenAttempted);
  await tag("WokenSucceeded", wokenSucceeded);
  await tag("ThresholdMinutes", thresholdMin);
  await tag("ValidationDelaySeconds", validationDelaySec);

  // Return TRUE if there ARE devices not reporting (stale/unknown)
  return DevicesNotReporting.length !== 0;
}

// Run
await wakeupDevices();
