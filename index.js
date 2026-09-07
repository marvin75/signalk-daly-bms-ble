const { DalyBMS, scanDalyDevices } = require('./lib/daly');

module.exports = function(app) {
  const plugin = {};

  plugin.id = 'signalk-daly-bms-ble';
  plugin.name = 'Daly BMS';
  plugin.description =
    'Reads one or more Daly Smart BMS devices over Bluetooth LE and publishes them to Signal K.';

  let running = false;
  let workers = [];

  plugin.registerWithRouter = function(router) {
    router.get('/scan', async (req, res) => {
      try {
        app.setPluginStatus('Scanning for Daly BMS devices...');

        const devices = await scanDalyDevices(8);

        app.setPluginStatus(
          `BLE scan complete: ${devices.length} Daly device(s) found`
        );

        res.json({ devices });

      } catch (err) {
        app.error(`Daly BLE scan failed: ${err.stack || err.message}`);

        app.setPluginError(
          `BLE scan failed: ${err.message}`
        );

        res.status(500).json({
          error: err.message
        });
      }
    });
  };

  plugin.schema = {
    type: 'object',

    properties: {
      batteries: {
        type: 'array',
        title: 'Daly devices',

        items: {
          type: 'object',

          properties: {
            device: {
              type: 'string',
              title: 'Daly Bluetooth device'
            },

            name: {
              type: 'string',
              title: 'Bluetooth name'
            },

            batteryId: {
              type: 'string',
              title: 'Battery ID'
            }
          },

          required: [
            'device',
            'batteryId'
          ]
        },

        default: []
      },

      pollInterval: {
        type: 'number',
        title: 'Poll interval',
        minimum: 1,
        maximum: 60,
        default: 5
      },

      publishBasic: {
        type: 'boolean',
        default: true
      },

      publishCells: {
        type: 'boolean',
        default: true
      },

      publishTemperatures: {
        type: 'boolean',
        default: true
      },

      publishStatus: {
        type: 'boolean',
        default: true
      },

      publishCapacity: {
        type: 'boolean',
        default: true
      },

      publishBalancing: {
        type: 'boolean',
        default: true
      },

      publishAlarms: {
        type: 'boolean',
        default: true
      }
    }
  };

  function value(values, path, v) {
    if (v !== undefined && v !== null) {
      values.push({
        path,
        value: v
      });
    }
  }

  function makeDelta(settings, batteryId, data) {
    const base =
      `electrical.batteries.${batteryId}`;

    const values = [];

    if (settings.publishBasic !== false) {
      value(
        values,
        `${base}.voltage`,
        data.voltage
      );

      value(
        values,
        `${base}.current`,
        data.current
      );

      if (data.soc !== undefined) {
        value(
          values,
          `${base}.capacity.stateOfCharge`,
          data.soc / 100
        );
      }

      if (
        data.voltage !== undefined &&
        data.current !== undefined
      ) {
        value(
          values,
          `${base}.power`,
          data.voltage * data.current
        );
      }
    }

    if (settings.publishCells !== false) {
      for (
        const [cell, voltage]
        of Object.entries(data.cells || {})
      ) {
        value(
          values,
          `${base}.cells.${cell}.voltage`,
          voltage
        );
      }

      value(
        values,
        `${base}.cells.minimumVoltage`,
        data.minCellVoltage
      );

      value(
        values,
        `${base}.cells.maximumVoltage`,
        data.maxCellVoltage
      );

      value(
        values,
        `${base}.cells.deltaVoltage`,
        data.cellDelta
      );

      value(
        values,
        `${base}.cells.minimumCell`,
        data.minCell
      );

      value(
        values,
        `${base}.cells.maximumCell`,
        data.maxCell
      );
    }

    if (settings.publishTemperatures !== false) {
      for (
        const [sensor, temperature]
        of Object.entries(data.temperatures || {})
      ) {
        const temperaturePath =
          `${base}.temperatures.${sensor}`;

        app.setDefaultMetadata(
          temperaturePath,
          {
            units: 'K',
            description: `Battery temperature sensor ${sensor}`
          }
        );

        value(
          values,
          temperaturePath,
          temperature + 273.15
        );
      }

      if (data.maxTemperature !== undefined) {
        value(
          values,
          `${base}.bms.maximumTemperature`,
          data.maxTemperature + 273.15
        );
      }

      if (data.minTemperature !== undefined) {
        value(
          values,
          `${base}.bms.minimumTemperature`,
          data.minTemperature + 273.15
        );
      }
    }

    if (settings.publishStatus !== false) {
      value(
        values,
        `${base}.bms.mode`,
        data.mode
      );

      value(
        values,
        `${base}.bms.chargeMosfet`,
        data.chargeMosfet
      );

      value(
        values,
        `${base}.bms.dischargeMosfet`,
        data.dischargeMosfet
      );

      value(
        values,
        `${base}.bms.chargerConnected`,
        data.chargerRunning
      );

      value(
        values,
        `${base}.bms.loadConnected`,
        data.loadRunning
      );
    }

    if (settings.publishCapacity !== false) {
      value(
        values,
        `${base}.bms.remainingCapacity`,
        data.remainingCapacityAh
      );

      value(
        values,
        `${base}.bms.cycles`,
        data.cycles
      );

      value(
        values,
        `${base}.bms.cellCount`,
        data.cellCount
      );
    }

    if (settings.publishBalancing !== false) {
      value(
        values,
        `${base}.bms.balancing`,
        data.balancing || []
      );

      value(
        values,
        `${base}.bms.balancingActive`,
        !!(
          data.balancing &&
          data.balancing.length
        )
      );
    }

    if (settings.publishAlarms !== false) {
      value(
        values,
        `${base}.bms.errors`,
        data.errors || []
      );

      value(
        values,
        `${base}.bms.alarmActive`,
        !!(
          data.errors &&
          data.errors.length
        )
      );
    }

    return {
      updates: [
        {
          source: {
            label: `daly-bms.${batteryId}`
          },

          timestamp:
            new Date().toISOString(),

          values
        }
      ]
    };
  }

  function getConfiguredBatteries(settings) {
    if (
      Array.isArray(settings.batteries) &&
      settings.batteries.length
    ) {
      return settings.batteries.filter(
        item =>
          item &&
          item.device &&
          item.batteryId
      );
    }

    /*
     * Backwards compatibility with our original
     * single-device configuration.
     */
    if (settings.device) {
      return [
        {
          device: settings.device,
          batteryId:
            settings.batteryId || 'house'
        }
      ];
    }

    return [];
  }

  function updateOverallStatus() {
    if (!workers.length) {
      app.setPluginStatus(
        'No Daly devices configured'
      );
      return;
    }

    const connected =
      workers.filter(
        worker => worker.connected
      ).length;

    const summaries =
      workers
        .filter(
          worker =>
            worker.connected &&
            worker.lastData
        )
        .map(worker => {
          const d = worker.lastData;

          let text =
            `${worker.config.batteryId}: ` +
            `${d.voltage !== undefined ? d.voltage.toFixed(2) : '?'} V`;

          if (d.soc !== undefined) {
            text += ` ${d.soc.toFixed(0)}%`;
          }

          return text;
        });

    let status =
      `${connected}/${workers.length} Daly device(s) connected`;

    if (summaries.length) {
      status += ` | ${summaries.join(' | ')}`;
    }

    app.setPluginStatus(status);
  }

  async function runWorker(worker, settings) {
    const interval =
      Math.max(
        1,
        Number(settings.pollInterval) || 5
      ) * 1000;

    while (running && !worker.stop) {
      try {
        if (!worker.bms) {
          worker.connected = false;
          updateOverallStatus();

          worker.bms =
            new DalyBMS(
              worker.config.device
            );

          await worker.bms.connect();

          worker.connected = true;
          updateOverallStatus();
        }

        const data =
          await worker.bms.readAll();

        if (
          data.voltage === undefined ||
          data.soc === undefined
        ) {
          throw new Error(
            'No valid basic BMS data received'
          );
        }

        worker.lastData = data;
        worker.connected = true;

        app.handleMessage(
          plugin.id,
          makeDelta(
            settings,
            worker.config.batteryId,
            data
          ),
          'v1'
        );

        updateOverallStatus();

        await new Promise(resolve =>
          setTimeout(resolve, interval)
        );

      } catch (err) {
        worker.connected = false;

        app.error(
          `Daly ${worker.config.batteryId} ` +
          `(${worker.config.device}): ` +
          `${err.stack || err.message}`
        );

        if (worker.bms) {
          try {
            await worker.bms.disconnect();
          } catch {}

          worker.bms = null;
        }

        updateOverallStatus();

        if (
          running &&
          !worker.stop
        ) {
          await new Promise(resolve =>
            setTimeout(resolve, 5000)
          );
        }
      }
    }
  }

  plugin.start = async function(settings) {
    running = true;
    workers = [];

    const batteries =
      getConfiguredBatteries(settings);

    if (!batteries.length) {
      app.setPluginStatus(
        'No Daly devices configured'
      );
      return;
    }

    const seenDevices = new Set();
    const seenIds = new Set();

    for (const config of batteries) {
      const deviceKey =
        String(config.device)
          .trim()
          .toUpperCase();

      const idKey =
        String(config.batteryId)
          .trim();

      if (
        seenDevices.has(deviceKey)
      ) {
        app.error(
          `Duplicate Daly device ignored: ${config.device}`
        );
        continue;
      }

      if (
        seenIds.has(idKey)
      ) {
        app.error(
          `Duplicate Battery ID ignored: ${config.batteryId}`
        );
        continue;
      }

      seenDevices.add(deviceKey);
      seenIds.add(idKey);

      const base =
        `electrical.batteries.${idKey}`;

      await app.setDefaultMetadata(
        `${base}.bms.maximumTemperature`,
        {
          units: 'K',
          description: 'Maximum BMS temperature'
        }
      );

      await app.setDefaultMetadata(
        `${base}.bms.minimumTemperature`,
        {
          units: 'K',
          description: 'Minimum BMS temperature'
        }
      );

      const worker = {
        config: {
          ...config,
          batteryId: idKey
        },

        bms: null,
        connected: false,
        lastData: null,
        stop: false,
        promise: null
      };

      workers.push(worker);
    }

    updateOverallStatus();

    for (const worker of workers) {
      worker.promise =
        runWorker(
          worker,
          settings
        );
    }
  };

  plugin.stop = async function() {
    running = false;

    for (const worker of workers) {
      worker.stop = true;
    }

    for (const worker of workers) {
      if (worker.bms) {
        try {
          await worker.bms.disconnect();
        } catch {}

        worker.bms = null;
      }
    }

    await Promise.allSettled(
      workers.map(worker =>
        worker.promise
          ? Promise.race([
              worker.promise,

              new Promise(resolve =>
                setTimeout(resolve, 2000)
              )
            ])
          : Promise.resolve()
      )
    );

    workers = [];

    app.setPluginStatus('Stopped');
  };

  return plugin;
};
