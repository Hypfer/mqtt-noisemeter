const { Worker } = require('worker_threads');
const path = require('path');

const config = require('./config');
const logger = require('./logger');
const MqttClient = require('./mqtt-client');
const NoiseAnalyzer = require('./noise-analyzer');

class NoiseMonitor {
    constructor() {
        this.config = config;

        // Shared buffer setup
        this.bufferSize = Math.floor(config.sampleRate * config.bufferDuration);
        this.sharedBuffer = new SharedArrayBuffer(this.bufferSize * 4); // 4 bytes per float32
        this.audioBuffer = new Float32Array(this.sharedBuffer);
        this.sharedMeta = new SharedArrayBuffer(16); // writeIndex, overruns, etc.
        this.metaData = new Int32Array(this.sharedMeta);

        // Components
        this.mqttClient = new MqttClient(config);
        this.analyzer = new NoiseAnalyzer(config, this.audioBuffer, this.metaData);
        this.audioWorker = null;

        // Control
        this.isShuttingDown = false;
        this.processingTimer = null;

        // Stats
        this.streamStartTime = null;
        this.readyToPublish = false;
        this.startupWait = Math.max(config.analysisWindow * 2, 20.0);

        // Setup signal handlers
        this.setupSignalHandlers();
    }

    setupSignalHandlers() {
        process.on('SIGINT', () => {
            logger.info('Received SIGINT');
            this.shutdown();
        });

        process.on('SIGTERM', () => {
            logger.info('Received SIGTERM');
            this.shutdown();
        });
    }

    setupAudioWorker() {
        return new Promise((resolve, reject) => {
            this.audioWorker = new Worker(path.join(__dirname, 'audio-worker.js'), {
                workerData: {
                    audioDevice: this.config.audioDevice,
                    sampleRate: this.config.sampleRate,
                    channels: this.config.channels,
                    bufferSize: this.bufferSize,
                    sharedBuffer: this.sharedBuffer,
                    sharedMeta: this.sharedMeta,
                    debug: this.config.debug
                }
            });

            this.audioWorker.on('message', (message) => {
                switch (message.type) {
                    case 'started':
                        logger.info(`Audio recording started with format: ${message.format}`);
                        this.streamStartTime = Date.now();
                        resolve();
                        break;
                    case 'error':
                        logger.error(`Audio worker error: ${message.error}`);
                        reject(new Error(message.error));
                        break;
                    case 'exit':
                        if (!this.isShuttingDown) {
                            logger.error('Audio worker exited unexpectedly');
                            this.shutdown();
                        }
                        break;
                }
            });

            this.audioWorker.on('error', (error) => {
                logger.error(`Worker thread error: ${error.message}`);
                reject(error);
            });

            this.audioWorker.on('exit', (code) => {
                if (code !== 0 && !this.isShuttingDown) {
                    logger.error(`Worker stopped with exit code ${code}`);
                }
            });
        });
    }

    startProcessingLoop() {
        const processLoop = () => {
            if (this.isShuttingDown) {
                return;
            }

            try {
                const audioWorking = Atomics.load(this.metaData, 2);
                if (!audioWorking) {
                    this.processingTimer = setTimeout(processLoop, 1000);
                    return;
                }

                if (!this.readyToPublish) {
                    if (this.streamStartTime && (Date.now() - this.streamStartTime) >= this.startupWait * 1000) {
                        this.readyToPublish = true;
                        logger.info('Audio buffer ready, starting publications');
                    } else {
                        this.processingTimer = setTimeout(processLoop, 1000);
                        return;
                    }
                }

                const data = this.analyzer.analyze();
                if (data) {
                    this.mqttClient.publishData(data);
                } else {
                    logger.debug('No valid audio data to publish');
                }

                this.processingTimer = setTimeout(processLoop, this.config.publishInterval * 1000);
            } catch (error) {
                logger.error(`Error in processing loop: ${error.message}`);
                this.processingTimer = setTimeout(processLoop, 1000);
            }
        };

        processLoop();
    }

    async run() {
        try {
            logger.info(`Buffer size: ${this.bufferSize} samples (${this.config.bufferDuration}s)`);

            await this.mqttClient.connect();
            await this.setupAudioWorker();

            this.startProcessingLoop();

            logger.info('MQTT Noise Meter started - press Ctrl+C to stop');

            const keepAlive = () => {
                if (!this.isShuttingDown) {
                    setTimeout(keepAlive, 1000);
                }
            };
            keepAlive();

        } catch (error) {
            logger.error(`Error in main execution: ${error.message}`);
            this.shutdown();
        }
    }

    shutdown() {
        if (this.isShuttingDown) {
            return;
        }

        logger.info('Shutting down...');
        this.isShuttingDown = true;

        const overrunCount = Atomics.load(this.metaData, 1);
        if (overrunCount > 0) {
            logger.info(`Total overruns: ${overrunCount}`);
        }

        if (this.processingTimer) {
            clearTimeout(this.processingTimer);
        }

        if (this.audioWorker) {
            this.audioWorker.terminate();
        }

        this.mqttClient.disconnect();

        logger.info('Shutdown complete');
        process.exit(0);
    }
}

module.exports = NoiseMonitor;