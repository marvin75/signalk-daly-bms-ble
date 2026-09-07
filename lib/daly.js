const { createBluetooth } = require('node-ble');

const SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
const NOTIFY  = '0000fff1-0000-1000-8000-00805f9b34fb';
const WRITE   = '0000fff2-0000-1000-8000-00805f9b34fb';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeAddress(input) {
  const s = String(input || '').trim().toUpperCase();

  if (/^DL-[0-9A-F]{12}$/.test(s)) {
    const h = s.slice(3);
    return h.match(/../g).join(':');
  }

  if (/^[0-9A-F]{12}$/.test(s)) {
    return s.match(/../g).join(':');
  }

  if (/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(s)) {
    return s;
  }

  throw new Error(
    'Invalid Daly device. Use DL-XXXXXXXXXXXX or XX:XX:XX:XX:XX:XX'
  );
}

function makeRequest(command) {
  const b = Buffer.from([
    0xA5, 0x80, command, 0x08,
    0,0,0,0,0,0,0,0,
    0
  ]);

  let sum = 0;
  for (let i = 0; i < 12; i++) sum += b[i];
  b[12] = sum & 0xff;

  return b;
}

function validFrame(f) {
  if (f.length !== 13 || f[0] !== 0xA5) return false;

  let sum = 0;
  for (let i = 0; i < 12; i++) sum += f[i];

  return (sum & 0xff) === f[12];
}

class DalyBMS {
  constructor(deviceInput) {
    this.address = normalizeAddress(deviceInput);

    this.bluetoothContext = null;
    this.device = null;
    this.notifyChar = null;
    this.writeChar = null;

    this.data = this.newData();
  }

  newData() {
    return {
      cells: {},
      temperatures: {},
      balancing: [],
      errors: []
    };
  }

  parseFrame(f) {
    if (!validFrame(f)) return;

    const d = this.data;

    switch (f[2]) {
      case 0x90:
        d.voltage = f.readUInt16BE(4) / 10;
        d.current = (f.readUInt16BE(8) - 30000) / 10;
        d.soc = f.readUInt16BE(10) / 10;
        break;

      case 0x91:
        d.maxCellVoltage = f.readUInt16BE(4) / 1000;
        d.maxCell = f[6];
        d.minCellVoltage = f.readUInt16BE(7) / 1000;
        d.minCell = f[9];
        d.cellDelta = d.maxCellVoltage - d.minCellVoltage;
        break;

      case 0x92:
        d.maxTemperature = f[4] - 40;
        d.maxTemperatureSensor = f[5];
        d.minTemperature = f[6] - 40;
        d.minTemperatureSensor = f[7];
        break;

      case 0x93: {
        const state = f[4];

        d.mode =
          state === 0 ? 'stationary' :
          state === 1 ? 'charging' :
          state === 2 ? 'discharging' :
          'unknown';

        d.chargeMosfet = !!f[5];
        d.dischargeMosfet = !!f[6];
        d.heartbeat = f[7];
        d.remainingCapacityAh = f.readUInt32BE(8) / 1000;
        break;
      }

      case 0x94:
        d.cellCount = f[4];
        d.temperatureSensorCount = f[5];
        d.chargerRunning = !!f[6];
        d.loadRunning = !!f[7];
        d.digitalIO = f[8];
        d.cycles = f.readUInt16BE(9);
        break;

      case 0x95: {
        const frameNo = f[4];

        for (let i = 0; i < 3; i++) {
          const cell = (frameNo - 1) * 3 + i + 1;
          const mv = f.readUInt16BE(5 + i * 2);

          if (mv > 0 && (!d.cellCount || cell <= d.cellCount)) {
            d.cells[cell] = mv / 1000;
          }
        }
        break;
      }

      case 0x96: {
        const frameNo = f[4];

        for (let i = 0; i < 7; i++) {
          const sensor = (frameNo - 1) * 7 + i + 1;

          if (
            d.temperatureSensorCount &&
            sensor > d.temperatureSensorCount
          ) break;

          const raw = f[5 + i];

          if (raw !== 0) {
            d.temperatures[sensor] = raw - 40;
          }
        }

        break;
      }

      case 0x97: {
        d.balancing = [];
        const bits = f.subarray(4, 12);

        for (let byte = 0; byte < bits.length; byte++) {
          for (let bit = 0; bit < 8; bit++) {
            const cell = byte * 8 + bit + 1;

            if (d.cellCount && cell > d.cellCount) break;

            if (bits[byte] & (1 << bit)) {
              d.balancing.push(cell);
            }
          }
        }
        break;
      }

      case 0x98: {
        const alarmBytes = f.subarray(4, 12);
        d.errors = alarmBytes.some(v => v !== 0)
          ? [alarmBytes.toString('hex')]
          : [];
        break;
      }
    }
  }

  async connect() {
    this.bluetoothContext = createBluetooth();

    const { bluetooth } = this.bluetoothContext;
    const adapter = await bluetooth.defaultAdapter();

    if (!(await adapter.isPowered())) {
      await adapter.setPowered(true);
    }

    if (!(await adapter.isDiscovering())) {
      await adapter.startDiscovery();
    }

    this.device = await adapter.waitDevice(this.address);
    await this.device.connect();

    const gatt = await this.device.gatt();
    const service = await gatt.getPrimaryService(SERVICE);

    this.notifyChar = await service.getCharacteristic(NOTIFY);
    this.writeChar = await service.getCharacteristic(WRITE);

    this.notifyChar.on('valuechanged', packet => {
      for (
        let offset = 0;
        offset + 13 <= packet.length;
        offset += 13
      ) {
        const frame =
          packet.subarray(offset, offset + 13);

        this.parseFrame(frame);
      }
    });

    await this.notifyChar.startNotifications();
  }

  async readAll() {
    this.data = this.newData();

    const commands = [
      0x90, 0x91, 0x92, 0x93, 0x94,
      0x95, 0x96, 0x97, 0x98
    ];

    for (const cmd of commands) {
      await this.writeChar.writeValueWithoutResponse(
        makeRequest(cmd)
      );

      await sleep(
        cmd === 0x96 ? 1000 :
        cmd === 0x95 ? 500 :
        150
      );
    }

    await sleep(300);

    return JSON.parse(JSON.stringify(this.data));
  }

  async disconnect() {
    if (this.notifyChar) {
      try {
        await this.notifyChar.stopNotifications();
      } catch {}
    }

    if (this.device) {
      try {
        await this.device.disconnect();
      } catch {}
    }

    if (this.bluetoothContext) {
      try {
        this.bluetoothContext.destroy();
      } catch {}
    }

    this.notifyChar = null;
    this.writeChar = null;
    this.device = null;
    this.bluetoothContext = null;
  }
}


async function scanDalyDevices(scanSeconds = 8) {
  const bluetoothContext = createBluetooth();
  const { bluetooth } = bluetoothContext;

  const found = new Map();
  const inspected = new Set();

  try {
    const adapter = await bluetooth.defaultAdapter();

    if (!(await adapter.isPowered())) {
      await adapter.setPowered(true);
    }

    if (!(await adapter.isDiscovering())) {
      await adapter.startDiscovery();
    }

    const end = Date.now() + scanSeconds * 1000;

    while (Date.now() < end) {
      const addresses = await adapter.devices();

      for (const address of addresses) {
        const normalizedAddress = address.toUpperCase();

        if (inspected.has(normalizedAddress)) {
          continue;
        }

        inspected.add(normalizedAddress);

        try {
          const device = await adapter.getDevice(address);

          let name = '';

          try {
            name = await device.getName();
          } catch {}

          if (
            name &&
            (
              name.toUpperCase().startsWith('DL-') ||
              name.toUpperCase().startsWith('DALY')
            )
          ) {
            found.set(normalizedAddress, {
              address: normalizedAddress,
              name
            });
          }

        } catch {}
      }

      await sleep(500);
    }

    return Array.from(found.values());

  } finally {
    try {
      bluetoothContext.destroy();
    } catch {}
  }
}

module.exports = {
  DalyBMS,
  normalizeAddress,
  scanDalyDevices
};
