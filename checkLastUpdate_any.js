// Version 0.6
// Script checks devices based on the last updated time against a threshold
// Focuses on temperature sensors and specified device classes but you can adjust it by changing FILTER OPTIONS

// Constants
const NOT_REPORTING_THRESHOLD_HOURS = 0.8; // 0.8 hours, which is 48 minutes
const THRESHOLD_IN_MILLIS = NOT_REPORTING_THRESHOLD_HOURS * 3600000; // Convert hours to milliseconds

// Filter Options
const EXCLUDED_ZONES = ['Garage', 'Living Room']; // Add your zone names here (case-insensitive) to be  excluded
const EXCLUDED_DRIVER_URI_PATTERN = /vdevice|nl\.qluster-it\.DeviceCapabilities|nl\.fellownet\.chronograph|net\.i-dev\.betterlogic|com\.swttt\.devicegroups|com\.gruijter\.callmebot|com\.netscan/i;
const INCLUDED_DEVICE_NAME_REGEX = /.*/i; // Device names (case-insensitive) to be included
// EXAMPLE to include ALL : const INCLUDED_DEVICE_NAME_REGEX = /.*/i;
const EXCLUDED_DEVICE_NAME_PATTERN = /Flood|Netatmo Rain|Motion|Flora|Rear gate Vibration Sensor|Vibration Sensor Attic Doors/i;  // Device names (case-insensitive) to be excluded
const INCLUDED_DEVICE_CLASS_REGEX = /sensor|button|remote|socket|lights|bulb/i; // Device types/classes (case-insensitive) to be included
const EXCLUDED_FLAGS = ['']; // eg. to exclude ZWAVE and ZIGBEE - const EXCLUDED_FLAGS = ['zigbee','zwave'];. You can also set lowbattery, to exclude those devices with low battery state
const EXCLUDE_EMPTY_FLAGS = false; // Set to true to exclude devices with empty flags (eg. OTHER then Zigbee / ZWAVE devices)

// -------------- don't modify anything below --------------------

// Prepare tracking arrays
let okDevices = [];
let nokDevices = [];

// Overall tracking
let DevicesNotReporting = [];
let notReportingCount = 0;

// Fetch all devices and zones
const devices = await Homey.devices.getDevices();
const zones = await Homey.zones.getZones();
const zonesArray = Array.isArray(zones) ? zones : Object.values(zones);

// Create a map of zone ID to zone name
const zoneMap = {};
zonesArray.forEach(zone => {
  zoneMap[zone.id] = zone.name;
});

// Function to format date as "dd-mm-yyyy, hh:mm:ss"
function formatDate(date) {
  if (!date || isNaN(date.getTime())) return "Unknown";
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear().toString();
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  return `${day}-${month}-${year}, ${hours}:${minutes}:${seconds}`;
}

// Simple right-padding function for column formatting
function padRight(str, width) {
  if (str.length >= width) return str.slice(0, width);
  return str + ' '.repeat(width - str.length);
}

// For each device, apply filters and check lastUpdated times
for (const device of Object.values(devices)) {
  // 1) Exclude certain driver URIs (virtual devices, app placeholders, etc.)
  if (device.driverUri && EXCLUDED_DRIVER_URI_PATTERN.test(device.driverUri)) continue;

  // 2) Zone checks
  const zoneName = device.zone ? zoneMap[device.zone] : null;
  if (zoneName && EXCLUDED_ZONES.some(z => z.toLowerCase() === zoneName.toLowerCase())) {
    continue;
  }

  // 3) Name/class filters
  if (!device.name || !INCLUDED_DEVICE_NAME_REGEX.test(device.name)) continue;
  if (EXCLUDED_DEVICE_NAME_PATTERN.test(device.name)) continue;
  if (!device.class || !INCLUDED_DEVICE_CLASS_REGEX.test(device.class)) continue;

  // 4) Exclude based on technology
  if (
  (device.flags && EXCLUDED_FLAGS.some(flag => device.flags.includes(flag))) ||
  (EXCLUDE_EMPTY_FLAGS && Array.isArray(device.flags) && (device.flags.length === 0 || device.flags.includes('lowBattery'))) ) continue;

  // We'll track the most recent (max) lastUpdated across all capabilities
  let maxLastUpdatedTime = null;

  // Gather the latest lastUpdated
  if (device.capabilitiesObj) {
    for (const capability of Object.values(device.capabilitiesObj)) {
      if (!capability.lastUpdated) continue;
      const capTime = new Date(capability.lastUpdated).getTime();
      if (!maxLastUpdatedTime || capTime > maxLastUpdatedTime) {
        maxLastUpdatedTime = capTime;
      }
    }
  }

  // Now decide if the device is reporting or not
  let isReporting = false;
  if (maxLastUpdatedTime) {
    const timeSinceLastUpdated = Date.now() - maxLastUpdatedTime;
    // If the device's lastUpdated is within threshold, it's reporting
    if (timeSinceLastUpdated < THRESHOLD_IN_MILLIS) {
      isReporting = true;
    }
  }

  // Format the date from the maximum lastUpdated we found
  const lastUpdatedDate = maxLastUpdatedTime ? new Date(maxLastUpdatedTime) : null;
  const deviceInfo = {
    name: device.name,
    formattedDate: formatDate(lastUpdatedDate),
    class: device.class,
    status: isReporting ? '(OK)' : '(NOK)'
  };

  // If not reporting
  if (!isReporting) {
    notReportingCount++;
    DevicesNotReporting.push(`${deviceInfo.name} (${deviceInfo.formattedDate} - ${deviceInfo.class}) (NOK)`);
    nokDevices.push(deviceInfo);
  } else {
    okDevices.push(deviceInfo);
  }
}

// Log results in columns
const totalDevices = okDevices.length + nokDevices.length;
console.log(`${totalDevices} device(s) scanned.`);
console.log(`OK:  ${okDevices.length}`);
console.log(`NOK: ${nokDevices.length}`);
console.log('---------------------------------------------');

// Prepare column headers
const header = [
  padRight('#', 4),
  padRight('Device Name', 35),
  padRight('Last Updated', 20),
  padRight('Class', 10),
  padRight('Status', 6)
].join(' ');

// Helper to print rows in columns
function printRows(devArray) {
  devArray.forEach((row, idx) => {
    const line = [
      padRight(String(idx + 1), 4),
      padRight(row.name, 35),
      padRight(row.formattedDate, 20),
      padRight(row.class, 10),
      padRight(row.status, 6)
    ].join(' ');
    console.log(line);
  });
}

// Print OK devices
if (okDevices.length > 0) {
  console.log(`\nOK device(s): ${okDevices.length}`);
  console.log(header);
  console.log('-'.repeat(header.length));
  printRows(okDevices);
}

// Print NOK devices
if (nokDevices.length > 0) {
  console.log(`\nNOK device(s): ${nokDevices.length}`);
  console.log(header);
  console.log('-'.repeat(header.length));
  printRows(nokDevices);
}

console.log('---------------------------------------------\n');

// Output for script AND card
await tag('InvalidatedDevices', DevicesNotReporting.join('\n'));
await tag('notReportingCount', notReportingCount);

// Define a return value
const myTag = `Not Reporting Count: ${notReportingCount}\nDevices Not Reporting:\n${DevicesNotReporting.join('\n')}`;
return myTag;
