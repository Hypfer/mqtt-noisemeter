import os
import time
import json
import logging
import signal
import sys
from threading import Event, Thread, Lock
import sounddevice as sd
import numpy as np
import paho.mqtt.client as mqtt

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


class NoiseMonitor:
    def __init__(self):
        # Environment variables
        self.mqtt_host = os.getenv('MQTT_HOST', 'localhost')
        self.mqtt_port = int(os.getenv('MQTT_PORT', '1883'))
        self.mqtt_user = os.getenv('MQTT_USER', '')
        self.mqtt_password = os.getenv('MQTT_PASSWORD', '')
        self.mqtt_topic_prefix = os.getenv('MQTT_TOPIC_PREFIX', 'noisemeter')

        self.audio_device = os.getenv('AUDIO_DEVICE', None)
        self.sample_rate = None
        self.channels = int(os.getenv('CHANNELS', '1'))
        self.buffer_duration = float(os.getenv('BUFFER_DURATION', '30.0'))
        self.publish_interval = float(os.getenv('PUBLISH_INTERVAL', '5.0'))
        self.analysis_window = float(os.getenv('ANALYSIS_WINDOW', '10.0'))

        self.device_name = os.getenv('DEVICE_NAME', 'Noise Meter')
        self.device_id = os.getenv('DEVICE_ID', 'noisemeter_001')

        # Super simple circular buffer - just a big numpy array
        self.buffer_size = None  # Will be calculated
        self.audio_buffer = None
        self.write_index = 0
        self.buffer_lock = Lock()

        # Initialize MQTT client
        self.mqtt_client = mqtt.Client()
        if self.mqtt_user:
            self.mqtt_client.username_pw_set(self.mqtt_user, self.mqtt_password)

        self.mqtt_client.on_connect = self.on_mqtt_connect
        self.mqtt_client.on_disconnect = self.on_mqtt_disconnect

        # Audio stream
        self.audio_stream = None

        # Control
        self.shutdown_event = Event()
        self.processing_thread = None

        # Stats
        self.overflow_count = 0
        self.total_frames = 0

        # Startup tracking
        self.stream_start_time = None
        self.ready_to_publish = False

    def setup_audio_device(self):
        """Configure audio device"""
        try:
            if self.audio_device:
                try:
                    device_id = int(self.audio_device)
                    device_info = sd.query_devices(device_id)
                except ValueError:
                    devices = sd.query_devices()
                    device_info = None
                    for i, dev in enumerate(devices):
                        if self.audio_device.lower() in dev['name'].lower():
                            device_id = i
                            device_info = dev
                            break
                    if device_info is None:
                        raise ValueError(f"Device '{self.audio_device}' not found")
            else:
                device_info = sd.query_devices(kind='input')
                device_id = device_info['index']

            # Use device's native sample rate
            self.sample_rate = int(device_info['default_samplerate'])

            # Initialize circular buffer
            self.buffer_size = int(self.sample_rate * self.buffer_duration)
            self.audio_buffer = np.zeros(self.buffer_size, dtype=np.float32)

            sd.default.device = device_id
            sd.default.samplerate = self.sample_rate
            sd.default.channels = self.channels

            logger.info(f"Device: {device_info['name']}")
            logger.info(f"Sample rate: {self.sample_rate}Hz")
            logger.info(f"Buffer size: {self.buffer_size} samples ({self.buffer_duration}s)")

        except Exception as e:
            logger.error(f"Error setting up audio device: {e}")
            logger.info("Available devices:")
            print(sd.query_devices())
            raise

    def audio_callback(self, indata, frames, time_info, status):
        """Ultra-minimal callback - just copy data"""
        # Count status issues
        if status.input_overflow:
            self.overflow_count += 1

        # Get mono data with minimal processing
        if self.channels == 1:
            mono_data = indata[:, 0]
        else:
            mono_data = (indata[:, 0] + indata[:, 1]) * 0.5  # Simple stereo to mono

        # Write to circular buffer
        end_index = self.write_index + frames
        if end_index <= self.buffer_size:
            # Simple case - no wraparound
            self.audio_buffer[self.write_index:end_index] = mono_data
        else:
            # Wraparound case
            first_part = self.buffer_size - self.write_index
            self.audio_buffer[self.write_index:] = mono_data[:first_part]
            self.audio_buffer[:end_index - self.buffer_size] = mono_data[first_part:]

        self.write_index = end_index % self.buffer_size
        self.total_frames += frames

    def get_recent_audio(self, duration_seconds):
        """Get the most recent audio data"""
        samples_needed = int(self.sample_rate * duration_seconds)
        if samples_needed > self.buffer_size:
            samples_needed = self.buffer_size

        with self.buffer_lock:
            # Calculate start index
            start_index = (self.write_index - samples_needed) % self.buffer_size

            if start_index < self.write_index:
                # No wraparound
                return self.audio_buffer[start_index:self.write_index].copy()
            else:
                # Wraparound - concatenate two parts
                return np.concatenate([
                    self.audio_buffer[start_index:],
                    self.audio_buffer[:self.write_index]
                ])

    def calculate_db_from_samples(self, samples):
        """Calculate dB from audio samples"""
        if len(samples) == 0:
            return -80.0

        # Remove DC offset
        samples = samples - np.mean(samples)

        # Calculate RMS
        rms = np.sqrt(np.mean(samples ** 2))

        # Convert to dB
        if rms > 1e-10:
            db = 20 * np.log10(rms)
        else:
            db = -80.0

        return float(db)

    def analyze_audio(self):
        """Analyze recent audio and return statistics"""
        try:
            samples = self.get_recent_audio(self.analysis_window)

            if len(samples) == 0:
                return None

            # Split into 100ms chunks for min/max
            chunk_size = int(self.sample_rate * 0.1)
            db_values = []

            for i in range(0, len(samples), chunk_size):
                chunk = samples[i:i + chunk_size]
                if len(chunk) >= chunk_size // 2:
                    db = self.calculate_db_from_samples(chunk)
                    db_values.append(db)

            if db_values:
                overall_db = self.calculate_db_from_samples(samples)

                return {
                    'min_db': float(np.min(db_values)),
                    'max_db': float(np.max(db_values)),
                    'avg_db': overall_db,
                    'duration': len(samples) / self.sample_rate,
                    'overflows': self.overflow_count
                }

            return None

        except Exception as e:
            logger.error(f"Error analyzing audio: {e}")
            return None

    def on_mqtt_connect(self, client, userdata, flags, rc):
        if rc == 0:
            logger.info("Connected to MQTT broker")
            self.publish_discovery()
        else:
            logger.error(f"Failed to connect to MQTT broker: {rc}")

    def on_mqtt_disconnect(self, client, userdata, rc):
        logger.info("Disconnected from MQTT broker")

    def publish_discovery(self):
        """Publish Home Assistant autodiscovery configuration"""
        sensors = [
            {'name': 'min_db', 'friendly_name': 'Minimum dB', 'icon': 'mdi:volume-low'},
            {'name': 'max_db', 'friendly_name': 'Maximum dB', 'icon': 'mdi:volume-high'},
            {'name': 'avg_db', 'friendly_name': 'Average dB', 'icon': 'mdi:volume-medium'}
        ]

        for sensor in sensors:
            config = {
                "name": f"{self.device_name} {sensor['friendly_name']}",
                "unique_id": f"{self.device_id}_{sensor['name']}",
                "state_topic": f"{self.mqtt_topic_prefix}/{self.device_id}/{sensor['name']}",
                "unit_of_measurement": "dB",
                "device_class": "sound_pressure",
                "icon": sensor['icon'],
                "device": {
                    "identifiers": [self.device_id],
                    "name": self.device_name,
                    "model": "MQTT Noise Meter",
                    "manufacturer": "Custom"
                }
            }

            discovery_topic = f"homeassistant/sensor/{self.device_id}_{sensor['name']}/config"
            self.mqtt_client.publish(discovery_topic, json.dumps(config), retain=True)

        logger.info("Published Home Assistant discovery configuration")

    def publish_data(self, data):
        """Publish sensor data to MQTT"""
        if data:
            for key, value in data.items():
                if key in ['min_db', 'max_db', 'avg_db']:
                    topic = f"{self.mqtt_topic_prefix}/{self.device_id}/{key}"
                    self.mqtt_client.publish(topic, f"{value:.1f}")

            status = f" (overflows: {data['overflows']})" if data['overflows'] > 0 else ""
            logger.info(f"Published: min={data['min_db']:.1f}dB, max={data['max_db']:.1f}dB, "
                        f"avg={data['avg_db']:.1f}dB{status}")

    def processing_loop(self):
        """Background thread for processing and publishing"""
        logger.info("Starting processing loop...")

        while not self.shutdown_event.is_set():
            try:
                # Simple time-based check - only do this once
                if not self.ready_to_publish:
                    if self.stream_start_time and (time.time() - self.stream_start_time) >= self.analysis_window:
                        self.ready_to_publish = True
                        logger.info("Audio buffer ready, starting publications")
                    else:
                        self.shutdown_event.wait(1.0)  # Check every second
                        continue

                # Now we're ready - do normal analysis
                data = self.analyze_audio()

                if data:
                    self.publish_data(data)

                self.shutdown_event.wait(self.publish_interval)

            except Exception as e:
                logger.error(f"Error in processing loop: {e}")
                self.shutdown_event.wait(1.0)

    def run(self):
        """Main execution"""
        try:
            self.setup_audio_device()

            # Connect to MQTT
            logger.info(f"Connecting to MQTT broker: {self.mqtt_host}:{self.mqtt_port}")
            self.mqtt_client.connect(self.mqtt_host, self.mqtt_port, 60)
            self.mqtt_client.loop_start()

            # Start audio stream with large buffer for stability
            self.audio_stream = sd.InputStream(
                callback=self.audio_callback,
                channels=self.channels,
                samplerate=self.sample_rate,
                blocksize=0,  # Use default adaptive blocksize
                dtype=np.float32
            )

            self.audio_stream.start()
            self.stream_start_time = time.time()
            logger.info(f"Started audio stream")

            # Start processing thread
            self.processing_thread = Thread(target=self.processing_loop, daemon=True)
            self.processing_thread.start()

            logger.info("MQTT Noise Meter started - press Ctrl+C to stop")

            # Main loop
            while not self.shutdown_event.is_set():
                self.shutdown_event.wait(1.0)

        except KeyboardInterrupt:
            logger.info("Received interrupt signal")
        except Exception as e:
            logger.error(f"Error in main execution: {e}")
        finally:
            self.shutdown()

    def shutdown(self):
        """Clean shutdown"""
        logger.info("Shutting down...")

        if self.overflow_count > 0:
            logger.info(f"Total overflows: {self.overflow_count}")

        self.shutdown_event.set()

        if self.audio_stream:
            self.audio_stream.stop()
            self.audio_stream.close()

        if self.processing_thread:
            self.processing_thread.join(timeout=2.0)

        self.mqtt_client.loop_stop()
        self.mqtt_client.disconnect()

        logger.info("Shutdown complete")


# Global reference for signal handler
monitor = None


def signal_handler(signum, frame):
    if monitor:
        monitor.shutdown()
    sys.exit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    monitor = NoiseMonitor()
    monitor.run()