const mqtt = require('mqtt');
const logger = require('./logger');

class MqttClient {
    constructor(config) {
        this.config = config;
        this.client = null;
    }

    async connect() {
        const options = {
            host: this.config.mqttHost,
            port: this.config.mqttPort,
        };

        if (this.config.mqttUser) {
            options.username = this.config.mqttUser;
            options.password = this.config.mqttPassword;
        }

        return new Promise((resolve, reject) => {
            this.client = mqtt.connect(`mqtt://${this.config.mqttHost}:${this.config.mqttPort}`, options);

            this.client.on('connect', () => {
                logger.info('Connected to MQTT broker');
                this.publishDiscovery();
                resolve();
            });

            this.client.on('error', (error) => {
                logger.error(`MQTT error: ${error.message}`);
                reject(error);
            });

            this.client.on('disconnect', () => {
                logger.info('Disconnected from MQTT broker');
            });
        });
    }

    publishDiscovery() {
        const sensors = [
            { name: 'min_db', friendlyName: 'Minimum dB', icon: 'mdi:volume-low' },
            { name: 'max_db', friendlyName: 'Maximum dB', icon: 'mdi:volume-high' },
            { name: 'avg_db', friendlyName: 'Average dB', icon: 'mdi:volume-medium' },
            { name: 'median_db', friendlyName: 'Median dB', icon: 'mdi:volume-medium' }
        ];

        sensors.forEach(sensor => {
            const config = {
                name: `${this.config.deviceName} ${sensor.friendlyName}`,
                unique_id: `${this.config.deviceId}_${sensor.name}`,
                state_topic: `${this.config.mqttTopicPrefix}/${this.config.deviceId}/${sensor.name}`,
                unit_of_measurement: 'dB',
                device_class: 'sound_pressure',
                state_class: 'measurement',
                icon: sensor.icon,
                device: {
                    identifiers: [this.config.deviceId],
                    name: this.config.deviceName,
                    model: 'MQTT Noise Meter',
                    manufacturer: 'Custom'
                }
            };

            const discoveryTopic = `homeassistant/sensor/${this.config.deviceId}_${sensor.name}/config`;
            this.client.publish(discoveryTopic, JSON.stringify(config), { retain: true });
        });

        logger.info('Published Home Assistant discovery configuration');
    }

    publishData(data) {
        if (data) {
            const sensors = ['min_db', 'max_db', 'avg_db', 'median_db'];

            sensors.forEach(key => {
                if (key in data) {
                    const topic = `${this.config.mqttTopicPrefix}/${this.config.deviceId}/${key}`;
                    const value = data[key].toFixed(1);
                    this.client.publish(topic, value);
                }
            });

            const status = data.overruns > 0 ? ` (overruns: ${data.overruns})` : '';
            const logMsg = `Published: min=${data.min_db.toFixed(1)}dB, max=${data.max_db.toFixed(1)}dB, avg=${data.avg_db.toFixed(1)}dB, median=${data.median_db.toFixed(1)}dB`;

            logger.debug(logMsg + status);
        }
    }

    disconnect() {
        if (this.client) {
            this.client.end();
        }
    }
}

module.exports = MqttClient;