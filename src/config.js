module.exports = {
    // MQTT Settings
    mqttHost: process.env.MQTT_HOST || 'localhost',
    mqttPort: parseInt(process.env.MQTT_PORT || '1883'),
    mqttUser: process.env.MQTT_USER || '',
    mqttPassword: process.env.MQTT_PASSWORD || '',
    mqttTopicPrefix: process.env.MQTT_TOPIC_PREFIX || 'noisemeter',

    // Audio Settings
    audioDevice: process.env.AUDIO_DEVICE || 'default',
    sampleRate: parseInt(process.env.SAMPLE_RATE || '44100'),
    channels: parseInt(process.env.CHANNELS || '1'),

    // Processing Settings
    bufferDuration: parseFloat(process.env.BUFFER_DURATION || '30.0'),
    publishInterval: parseFloat(process.env.PUBLISH_INTERVAL || '15.0'),
    analysisWindow: parseFloat(process.env.ANALYSIS_WINDOW || '15.0'),

    // Device Identity
    deviceName: process.env.DEVICE_NAME || 'Noise Meter',
    deviceId: process.env.DEVICE_ID || 'noisemeter_001',

    // Debug
    debug: process.env.DEBUG === 'true'
};