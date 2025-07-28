// Zigbee Last-Seen & Battery Monitor – v0.8
//   • Checks LastSeen property of every non-excluded Zigbee device
//   • Flags devices not reporting for more than NotReportingThreshold hours
//   • Flags devices whose battery level is at/below BatteryThreshold %
//
//   Original idea: Caseda’s “Zigbee Overview” script.
//   Extended & refactored with ChatGPT assistance.
//
// ------------------------------- configurable constants -----------

// Duration (in hours) after which a device is considered “not reporting”
const NotReportingThreshold  = 2;            // hours

// Battery-level percentage at/below which a device is considered “low”
const BatteryThreshold       = 30;           // percent

// Zones to exclude (case-insensitive full-string match)
const EXCLUDED_ZONES         = ['Bathroom', 'Main Entry', 'Living Room'];
// const EXCLUDED_ZONES      = [];            // Uncomment to exclude none

// Device-class / name filters
const INCLUDED_DEVICE_CLASSES_REGEX = /sensor|button|remote|socket|lights/i;
const EXCLUDED_DEVICE_NAME_PATTERN  = /smoke|flood|bulb|spot/i;
const INCLUDED_DEVICE_NAME_PATTERN  = /.*/i; // e.g. /temperature/i to narrow

// Whether to include these Zigbee node types
const includeEndDevices = true;
const includeRouters    = true;

// ------------------------------- derived constants ----------------

const thresholdInMillis = NotReportingThreshold * 3600000; // h → ms

// ------------------------------- globals (counters & lists) --------

let notReportingCount   = 0;
let lowBatteryCount     = 0;

let DevicesNotReporting = [];
let DevicesLowBattery   = [];

// ------------------------------- helpers ---------------------------

// Format Date → "dd-mm-yyyy, hh:mm:ss"
function formatDate(date) {
  const pad = (n) => n.toString().padStart(2, '0');
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}, `
       + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Simple pad-right for console table layout
function padRight(str, width) {
  str = String(str);
  return str.length >= width ? str.slice(0, width) : str + ' '.repeat(width - str.length);
}

// ------------------------------- main routine ----------------------

async function checkZigbeeLastSeen() {
  try {
    /* ---------- fetch zones/devices/zigbee state ---------------- */
    const [zonesObj, devicesObj, zigbeeState] = await Promise.all([
      Homey.zones.getZones(),
      Homey.devices.getDevices(),
      Homey.zigbee.getState()
    ]);

    const allDevices = Object.values(devicesObj);

    // map zoneId → zoneName
    const zoneMap = {};
    Object.values(zonesObj).forEach(z => { zoneMap[z.id] = z.name; });

    /* ---------- stats holders ----------------------------------- */
    const okRows  = [];
    const nokRows = [];
    let routerCount = 0;
    let endDevCount = 0;
    let totalCount  = 0;

    /* ---------- iterate Zigbee nodes ---------------------------- */
    for (const node of Object.values(zigbeeState.nodes)) {
      const typeLower = node.type?.toLowerCase() || '';
      if ((!includeRouters && typeLower === 'router') ||
          (!includeEndDevices && typeLower === 'enddevice')) continue;

      totalCount++;

      const homeyDevice = allDevices.find(d => d.name === node.name);
      const zoneName    = homeyDevice?.zone ? zoneMap[homeyDevice.zone] : null;

      // Skip excluded zones
      if (zoneName && EXCLUDED_ZONES.some(z => z.toLowerCase() === zoneName.toLowerCase())) {
        continue;
      }

      // Apply class & name filters
      if (homeyDevice) {
        if (!INCLUDED_DEVICE_CLASSES_REGEX.test(homeyDevice.class || '')) continue;
        if (!INCLUDED_DEVICE_NAME_PATTERN.test(homeyDevice.name || ''))    continue;
        if (EXCLUDED_DEVICE_NAME_PATTERN.test(homeyDevice.name || ''))     continue;
      }

      /* ---------- last-seen check ------------------------------- */
      const lastSeenDate   = new Date(node.lastSeen);
      const timeDiffMillis = Date.now() - lastSeenDate.getTime();
      const dateFormatted  = formatDate(lastSeenDate);

      let statusMark = '(OK)';
      if (timeDiffMillis >= thresholdInMillis) {
        statusMark = '(NOK)';
        notReportingCount++;
        DevicesNotReporting.push(`${node.name} ${dateFormatted} (${typeLower})`);
      }

      /* ---------- battery check -------------------------------- */
      let batteryMsg = 'N/A';   // appended to console table if available
      if (homeyDevice?.capabilities?.includes('measure_battery')) {
        const battVal = homeyDevice.capabilitiesObj.measure_battery.value;
        if (typeof battVal === 'number') {
          batteryMsg = `${battVal}%`;
          if (battVal <= BatteryThreshold) {
            lowBatteryCount++;
            DevicesLowBattery.push(`${node.name} ${battVal}%`);
          }
        }
      }

      /* ---------- update type counters -------------------------- */
      if (typeLower === 'router')     routerCount++;
      if (typeLower === 'enddevice')  endDevCount++;

      /* ---------- keep row for later printing ------------------- */
      const rowObj = {
        name   : node.name || '(unknown)',
        date   : dateFormatted,
        type   : typeLower,
        status : statusMark,
        batt   : batteryMsg
      };
      (statusMark === '(OK)' ? okRows : nokRows).push(rowObj);
    }

    /* ---------- console output ---------------------------------- */
    console.log(`${totalCount} Zigbee device(s) scanned.`);
    console.log(`OK :  ${okRows.length}`);
    console.log(`NOK:  ${nokRows.length}`);
    console.log(`Router: ${routerCount}, EndDevice: ${endDevCount}`);
    console.log('---------------------------------------------');

    const header = [
      padRight('#', 3),
      padRight('Device Name', 35),
      padRight('Last Seen', 20),
      padRight('Type', 10),
      padRight('Batt', 5),
      padRight('Status', 6)
    ].join(' ');

    function printRows(arr) {
      arr.forEach((r, i) => {
        console.log([
          padRight(i + 1, 3),
          padRight(r.name, 35),
          padRight(r.date, 20),
          padRight(r.type, 10),
          padRight(r.batt, 5),
          padRight(r.status, 6)
        ].join(' '));
      });
    }

    if (okRows.length) {
      console.log(`\nOK Zigbee device(s): ${okRows.length}`);
      console.log(header);
      console.log('-'.repeat(header.length));
      printRows(okRows);
    }

    if (nokRows.length) {
      console.log(`\nNOK Zigbee device(s): ${nokRows.length}`);
      console.log(header);
      console.log('-'.repeat(header.length));
      printRows(nokRows);
    }

    if (lowBatteryCount) {
      console.log(`\nLow-battery device(s) (≤${BatteryThreshold}%): ${lowBatteryCount}`);
      DevicesLowBattery.forEach((d, i) => console.log(`${i + 1}. ${d}`));
    }

    console.log('---------------------------------------------\n');

    /* ---------- Flow tags --------------------------------------- */
    await tag('InvalidatedDevices', DevicesNotReporting.join('\n'));
    await tag('notReportingCount', notReportingCount);
    await tag('LowBatteryDevices',  DevicesLowBattery.join('\n'));
    await tag('lowBatteryCount',    lowBatteryCount);

    /* ---------- return value for script runner ------------------ */
    const result =
      `Not Reporting Count: ${notReportingCount}\n` +
      `Low Battery Count:   ${lowBatteryCount}\n` +
      `Devices Not Reporting:\n${DevicesNotReporting.join('\n')}\n` +
      `Devices Low Battery:\n${DevicesLowBattery.join('\n')}`;

    return result;

  } catch (err) {
    console.error('Failed: getting Zigbee state', err);
    await tag('InvalidatedDevices', '');
    await tag('notReportingCount', -1);
    await tag('LowBatteryDevices', '');
    await tag('lowBatteryCount',   -1);
    return 'Error while retrieving Zigbee state';
  }
}

/* ------------------------------- run ----------------------------- */

const myTag = await checkZigbeeLastSeen();
return myTag;
