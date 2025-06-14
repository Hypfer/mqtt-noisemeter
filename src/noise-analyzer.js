const logger = require('./logger');

class NoiseAnalyzer {
    constructor(config, audioBuffer, metaData) {
        this.config = config;
        this.audioBuffer = audioBuffer;
        this.metaData = metaData;
        this.bufferSize = Math.floor(config.sampleRate * config.bufferDuration);
    }

    getRecentAudio(durationSeconds) {
        const samplesNeeded = Math.floor(this.config.sampleRate * durationSeconds);
        const actualSamples = Math.min(samplesNeeded, this.bufferSize);

        // Atomically read the write index
        const writeIndex = Atomics.load(this.metaData, 0);
        const startIndex = (writeIndex - actualSamples + this.bufferSize) % this.bufferSize;

        if (startIndex < writeIndex) {
            return this.audioBuffer.slice(startIndex, writeIndex);
        } else {
            const firstPart = this.audioBuffer.slice(startIndex);
            const secondPart = this.audioBuffer.slice(0, writeIndex);
            const result = new Float32Array(firstPart.length + secondPart.length);
            result.set(firstPart, 0);
            result.set(secondPart, firstPart.length);
            return result;
        }
    }

    calculateDbFromSamples(samples) {
        if (samples.length === 0) {
            return -80.0;
        }

        const mean = samples.reduce((sum, val) => sum + val, 0) / samples.length;
        let sumSquares = 0;

        for (let i = 0; i < samples.length; i++) {
            const sample = samples[i] - mean;
            sumSquares += sample * sample;
        }

        const rms = Math.sqrt(sumSquares / samples.length);

        if (rms > 1e-10) {
            return 20 * Math.log10(rms);
        } else {
            return -80.0;
        }
    }

    analyze() {
        // Check if audio is working
        const audioWorking = Atomics.load(this.metaData, 2);
        if (!audioWorking) {
            return null;
        }

        try {
            const samples = this.getRecentAudio(this.config.analysisWindow);

            if (samples.length === 0) {
                return null;
            }

            const overallDb = this.calculateDbFromSamples(samples);
            if (overallDb <= -70.0) {
                logger.debug('Skipping analysis - mostly silence detected');
                return null;
            }

            const chunkSize = Math.floor(this.config.sampleRate * 0.1);
            const dbValues = [];

            for (let i = 0; i < samples.length; i += chunkSize) {
                const chunk = samples.slice(i, i + chunkSize);
                if (chunk.length >= chunkSize / 2) {
                    const db = this.calculateDbFromSamples(chunk);
                    if (db > -70.0) {
                        dbValues.push(db);
                    }
                }
            }

            if (dbValues.length === 0) {
                logger.debug('No valid audio chunks found');
                return null;
            }

            const sortedDbValues = [...dbValues].sort((a, b) => a - b);
            const median = sortedDbValues.length % 2 === 0
                ? (sortedDbValues[sortedDbValues.length / 2 - 1] + sortedDbValues[sortedDbValues.length / 2]) / 2
                : sortedDbValues[Math.floor(sortedDbValues.length / 2)];

            const overrunCount = Atomics.load(this.metaData, 1);
            return {
                min_db: Math.min(...dbValues),
                max_db: Math.max(...dbValues),
                avg_db: overallDb,
                median_db: median,
                duration: samples.length / this.config.sampleRate,
                overruns: overrunCount
            };
        } catch (error) {
            logger.error(`Error analyzing audio: ${error.message}`);
            return null;
        }
    }
}

module.exports = NoiseAnalyzer;