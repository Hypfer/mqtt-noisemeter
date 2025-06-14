const { spawn } = require('child_process');
const { parentPort, workerData } = require('worker_threads');

const {
    audioDevice,
    sampleRate,
    channels,
    bufferSize,
    sharedBuffer,
    sharedMeta,
    debug
} = workerData;

const audioBuffer = new Float32Array(sharedBuffer);
const metaData = new Int32Array(sharedMeta);

let arecordProcess = null;
let audioFormat = null;
let isShuttingDown = false;

function processAudioData(data) {
    const { bytesPerSample } = audioFormat;
    const sampleCount = Math.floor(data.length / bytesPerSample);
    const samples = new Float32Array(sampleCount);

    if (audioFormat.format === 'S24_3LE') {
        // Process 24-bit signed little-endian audio
        for (let i = 0; i < sampleCount; i++) {
            const byteOffset = i * 3; // Each sample is 3 bytes

            // Combine 3 bytes into a 24-bit integer (little-endian)
            // Byte 0: least significant, Byte 2: most significant
            let value = data[byteOffset] |
                (data[byteOffset + 1] << 8) |
                (data[byteOffset + 2] << 16);

            // Check if the sign bit (bit 23) is set for negative numbers
            if (value & 0b100000000000000000000000) {
                // Sign-extend to 32-bit by setting upper 8 bits to 1
                value |= 0b11111111000000000000000000000000;
            }

            // Normalize to range [-1.0, 1.0]
            // Divide by 2^23 (8,388,608) - the maximum positive value for 24-bit signed
            samples[i] = value / 8388608.0;
        }
    } else if (audioFormat.format === 'S16_LE') {
        // Process 16-bit signed little-endian audio
        for (let i = 0; i < sampleCount; i++) {
            const byteOffset = i * 2; // Each sample is 2 bytes

            // Use DataView to read 16-bit signed integer (little-endian)
            const view = new DataView(data.buffer, data.byteOffset + byteOffset, 2);
            const value = view.getInt16(0, true); // true = little-endian

            // Normalize to range [-1.0, 1.0]
            // Divide by 2^15 (32,768) - the maximum positive value for 16-bit signed
            samples[i] = value / 32768.0;
        }
    }

    // Send the normalized samples to the audio buffer
    writeToBuffer(samples);
}

function writeToBuffer(samples) {
    const samplesLength = samples.length;
    const writeIndex = Atomics.load(metaData, 0);
    const endIndex = writeIndex + samplesLength;

    if (endIndex <= bufferSize) {
        audioBuffer.set(samples, writeIndex);
    } else {
        const firstPart = bufferSize - writeIndex;
        audioBuffer.set(samples.subarray(0, firstPart), writeIndex);
        audioBuffer.set(samples.subarray(firstPart), 0);
    }

    Atomics.store(metaData, 0, endIndex % bufferSize);
    Atomics.add(metaData, 3, samplesLength); // totalFrames
}

function setupAudioRecording() {
    const formats = [
        { format: 'S24_3LE', bytesPerSample: 3 },
        { format: 'S16_LE', bytesPerSample: 2 }
    ];

    const tryFormat = (formatIndex) => {
        if (formatIndex >= formats.length) {
            parentPort.postMessage({ type: 'error', error: 'No supported audio format found' });
            return;
        }

        const { format, bytesPerSample } = formats[formatIndex];
        audioFormat = { format, bytesPerSample };

        const args = [
            '-D', audioDevice,
            '-f', format,
            '-c', channels.toString(),
            '-r', sampleRate.toString(),
            '-t', 'raw',
            '--buffer-size=16384',
            '--period-size=4096'
        ];

        arecordProcess = spawn('arecord', args);
        let audioStarted = false;

        arecordProcess.on('error', (error) => {
            parentPort.postMessage({ type: 'error', error: `Failed to start arecord: ${error.message}` });
        });

        arecordProcess.on('exit', (code, signal) => {
            if (code !== 0 && !isShuttingDown) {
                setTimeout(() => tryFormat(formatIndex + 1), 100);
                return;
            }

            if (!isShuttingDown) {
                parentPort.postMessage({ type: 'exit' });
            }
        });

        arecordProcess.stderr.on('data', (data) => {
            const message = data.toString().trim();
            if (message) {
                if (message.includes('Sample format non available') || message.includes('Available formats')) {
                    return;
                }
                if (message.includes('overrun')) {
                    Atomics.add(metaData, 1, 1); // increment overrun count
                    return;
                }
            }
        });

        arecordProcess.stdout.on('data', (data) => {
            if (!audioStarted) {
                audioStarted = true;
                Atomics.store(metaData, 2, 1); // audioWorking = true
                parentPort.postMessage({ type: 'started', format });
            }
            processAudioData(data);
        });

        setTimeout(() => {
            if (!audioStarted && !isShuttingDown) {
                arecordProcess.kill();
            }
        }, 2000);
    };

    tryFormat(0);
}

// Handle messages from main thread
parentPort.on('message', (message) => {
    if (message.type === 'shutdown') {
        isShuttingDown = true;
        if (arecordProcess) {
            arecordProcess.kill('SIGTERM');
        }
    }
});

// Start audio recording
setupAudioRecording();