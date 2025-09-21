// v0.8 — Any-device LastUpdated + Battery monitor
// - NA/invalid lastUpdated ⇒ NOK with reason codes (“no updates”)
// - Uses system/runtime time zone by default (universal); optional TIME_ZONE override
// - Battery: measure_battery (<= threshold) and/or alarm_battery=true
// - Tags: InvalidatedDevices, notReportingCount, LowBatteryDevices, lowBatteryCount

const vars = await Homey.logic.getVariables();
const variables = Object.keys(vars).reduce((acc, key) => {
  return {...acc, [vars[key].name]: vars[key].value };
}, {});

const config = {
  noReportThreshold: variables.noReportThreshold ?? 0.8,
  batteryThreshold: variables.batteryThreshold ?? 30,
  includeBatteryAlarm: variables.includeBatteryAlarm ?? true,
  separator: variables.separator ?? ' ', // set to e.g. '| ' for more visible separation
};

// Optional time zone override (e.g., "Europe/Prague"). Leave null/'' to use system TZ.
const TIME_ZONE = null;

// Zones, drivers, names, classes
const EXCLUDED_ZONES = ['Garage', 'Living Room']; // case-insensitive full-string match
const EXCLUDED_DRIVER_URI_PATTERN =
  /vdevice|nl\.qluster-it\.DeviceCapabilities|nl\.fellownet\.chronograph|net\.i-dev\.betterlogic|com\.swttt\.devicegroups|com\.gruijter\.callmebot|com\.netscan/i;

const INCLUDED_DEVICE_NAME_REGEX = /.*/i; // include all by default
const EXCLUDED_DEVICE_NAME_PATTERN =
  /Flood|Netatmo Rain|Motion|Flora|Rear gate Vibration Sensor|Vibration Sensor Attic Doors/i;

// NOTE: Homey class is "light" (singular), not "lights"
const INCLUDED_DEVICE_CLASS_REGEX = /sensor|button|remote|socket|light|bulb|other|switch|doorbell|speaker|blinds|tv|coffeemachine|vacuumcleaner|thermostat/i;

// Technology flags
const EXCLUDED_FLAGS = [''];         // e.g.: ['zigbee','zwave'] to exclude those stacks
const EXCLUDE_EMPTY_FLAGS = false;   // true => exclude devices with empty flags

// Label used when there have been no updates (invalid/absent timestamp)
const NO_UPDATES_LABEL = 'No updates';

// ───────────────────────── internals ────────────────────────────
const devices = await Homey.devices.getDevices();
const zones = await Homey.zones.getZones();
const zonesArray = Array.isArray(zones) ? zones : Object.values(zones);

const zoneMap = {};
zonesArray.forEach(z => { zoneMap[z.id] = z.name; });

// Function to format date as "dd-mm-yyyy, hh:mm:ss"
const formatDate = date => {
  if (!date || isNaN(date.getTime())) return NO_UPDATES_LABEL;
  const d = date;
  // Use system time zone unless TIME_ZONE is set
  const opts = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  };
  if (TIME_ZONE) opts.timeZone = TIME_ZONE;

  const parts = new Intl.DateTimeFormat('en-GB', opts).formatToParts(d);
  const get = (t) => parts.find(p => p.type === t)?.value ?? '';
  const DD = get('day').padStart(2, '0');
  const MM = get('month').padStart(2, '0');
  const YYYY = get('year');
  const HH = get('hour').padStart(2, '0');
  const mm = get('minute').padStart(2, '0');
  const ss = get('second').padStart(2, '0');
  return `${YYYY}-${MM}-${DD}, ${HH}:${mm}:${ss}`;
};

// Simple right-padding function for column formatting
const padRight = (str, width) => {
  str = String(str);
  if (str.length >= width) return str.slice(0, width);
  return str + ' '.repeat(width - str.length);
};

const deviceLowBatteryToText = device => `${device.name} ${device.batt}`;

const deviceNotReportingToText = rowObj => {
  const reason = rowObj.reason ? ` - ${rowObj.reason}` : '';
  return `${rowObj.name} (${rowObj.formattedDate} - ${rowObj.class}) (NOK)${reason}`;
};

const rowToText = (row, idx) => {
  const r = {...row, id: idx + 1};
  return ['', ...columns.map(c => padRight(r[c.field], c.width)), ''].join(config.separator);
};

const reports = Object.values(devices).map(device => {
  // 1) Exclude certain driver URIs (virtual devices, app placeholders, etc.)
  if (device.driverUri && EXCLUDED_DRIVER_URI_PATTERN.test(device.driverUri)) return null;

  // 2) Zone checks
  const zoneName = device.zone ? zoneMap[device.zone] : null;
  if (zoneName && EXCLUDED_ZONES.some(z => z.toLowerCase() === zoneName.toLowerCase())) return null;

  // 3) Name/class filters
  if (!device.name || !INCLUDED_DEVICE_NAME_REGEX.test(device.name)) return null;
  if (EXCLUDED_DEVICE_NAME_PATTERN.test(device.name)) return null;
  if (!device.class || !INCLUDED_DEVICE_CLASS_REGEX.test(device.class)) return null;

  // 4) Exclude based on technology
  if (
    (device.flags && EXCLUDED_FLAGS.some(flag => device.flags.includes(flag))) ||
    (EXCLUDE_EMPTY_FLAGS && Array.isArray(device.flags) && (device.flags.length === 0))
  ) return null;

  // Most recent lastUpdated across capabilities
  let mostRecentTs = NaN;
  if (device.capabilitiesObj) {
    for (const cap of Object.values(device.capabilitiesObj)) {
      const iso = cap?.lastUpdated;
      if (!iso) continue;
      const ts = new Date(iso).getTime();
      if (Number.isNaN(ts)) continue;
      if (Number.isNaN(mostRecentTs) || ts > mostRecentTs) mostRecentTs = ts;
    }
  }

  // Reporting decision
  const now = Date.now();
  let isReporting;
  let reason = '';

  if (Number.isNaN(mostRecentTs)) {
    isReporting = false;
    reason = 'NOK: no updates';
  } else {
    const age = now - mostRecentTs;
    if (age < config.noReportThreshold * 3600000) {
      isReporting = true;
    } else {
      isReporting = false;
      reason = `NOK: threshold ${(config.noReportThreshold)}h`;
    }
  }

  // -------- Battery checks --------
  let batteryStr = 'N/A';
  let isLowBattery = false;

  const caps = device.capabilities || [];
  const capsObj = device.capabilitiesObj || {};

  if (caps.includes('measure_battery')) {
    const v = capsObj.measure_battery?.value;
    if (typeof v === 'number' && !Number.isNaN(v)) {
      batteryStr = `${Math.round(v)}%`;
      if (v <= config.batteryThreshold) isLowBattery = true;
    }
  }

  if (caps.includes('alarm_battery')) {
    const alarmVal = !!(capsObj.alarm_battery?.value === true);
    if (alarmVal && config.includeBatteryAlarm) {
      isLowBattery = true;
      if (batteryStr === 'N/A') batteryStr = 'ALARM';
    } else if (batteryStr === 'N/A') {
      batteryStr = 'OK';
    }
  }

  const date = new Date(mostRecentTs);
  const formatted = Number.isNaN(mostRecentTs) ? NO_UPDATES_LABEL : formatDate(date);

  return {
    name: device.name,
    formattedDate: formatted,
    class: device.class,
    batt: batteryStr,
    status: isReporting ? '(OK)' : '(NOK)',
    date,
    reason,
    isLowBattery,
    isReporting,
  };
}).filter((rowObj) => !!rowObj);

const sortObjects = devs => devs.sort(function (a, b) {
  if (a.formattedDate === NO_UPDATES_LABEL) return 1;
  if (b.formattedDate === NO_UPDATES_LABEL) return -1;

  return a.formattedDate > b.formattedDate ? -1 : (a.formattedDate < b.formattedDate ? 1 : 0);
});

const okDevices = reports.filter(report => report.isReporting);
const nokDevices = reports.filter(report => !report.isReporting);

const DevicesNotReporting = nokDevices.map(deviceNotReportingToText);
const notReportingCount = DevicesNotReporting.length;

const DevicesLowBattery = reports.filter(report => report.isLowBattery).map(deviceLowBatteryToText);
const lowBatteryCount = DevicesLowBattery.length;

const columns = [
  {name: '#', width: 4, field: 'id'},
  {name: 'Device Name', width: 35, field: 'name'},
  {name: 'Last Updated', width: 21, field: 'formattedDate'},
  {name: 'Class', width: 14, field: 'class'},
  {name: 'Batt', width: 6, field: 'batt'},
  {name: 'Status', width: 7, field: 'status'},
]

// Prepare column headers
const header = columns.map(c => padRight(c.name, c.width)).join(config.separator);
const headerLabel = ['', header, ''].join(config.separator);
const headerTopBottom = '-'.repeat(headerLabel.length - 1);

// Helper to print rows in columns
const formatRows = devArray => sortObjects(devArray).map(rowToText);


function printHeaders() {
  console.log(headerTopBottom);
  console.log(headerLabel);
  console.log(headerTopBottom);
}

// Log results in columns
const totalDevices = okDevices.length + nokDevices.length;
console.log(`${totalDevices} device(s) scanned.`);
console.log(`OK:  ${okDevices.length}`);
console.log(`NOK: ${nokDevices.length}`);
console.log(`Low Battery (≤${(config.batteryThreshold)}%${config.includeBatteryAlarm ? ' or alarm' : ''}): ${lowBatteryCount}`);
console.log(headerTopBottom);

// Print OK devices
if (okDevices.length > 0) {
  console.log(`\nOK device(s): ${okDevices.length}`);
  printHeaders();
  console.log(formatRows(okDevices).join('\n'));
  console.log(headerTopBottom);
}

// Print NOK devices
if (nokDevices.length > 0) {
  console.log(`\nNOK device(s): ${nokDevices.length}`);
  printHeaders();
  console.log(formatRows(nokDevices).join('\n'));
  console.log(headerTopBottom);
}

// Print Low Battery devices (summary list)
if (lowBatteryCount > 0) {
  console.log(`\nLow-battery device(s) (≤${(config.batteryThreshold)}%${config.includeBatteryAlarm ? ' or alarm' : ''}): ${lowBatteryCount}`);
  DevicesLowBattery.forEach((d, i) => console.log(`${i + 1}. ${d}`));
}

console.log(`${headerTopBottom}\n`);

// Output for script AND card
await tag('InvalidatedDevices', DevicesNotReporting.join('\n'));
await tag('notReportingCount', notReportingCount);
// Added battery tags
await tag('LowBatteryDevices', DevicesLowBattery.join('\n'));
await tag('lowBatteryCount', lowBatteryCount);

// Define a return value
const myTag =
  `Not Reporting Count: ${notReportingCount}\n` +
  `Low Battery Count:   ${lowBatteryCount}\n` +
  `Devices Not Reporting:\n${DevicesNotReporting.join('\n')}` +
  (DevicesLowBattery.length ? `\nDevices Low Battery:\n${DevicesLowBattery.join('\n')}` : '');

return myTag;
