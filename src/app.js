#!/usr/bin/env node

const NoiseMonitor = require('./noise-monitor');
const logger = require('./logger');

// Create and run the monitor
const monitor = new NoiseMonitor();
monitor.run().catch(error => {
    logger.error(`Fatal error: ${error.message}`);
    process.exit(1);
});