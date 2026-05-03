import numpy as np

from Objects.ArrayConfig import ArrayConfig
from Objects.Physics.TargetEnviroment import TargetEnvironment

import numpy as np
from scipy.signal import fftconvolve

class PulseEchoEngine:
    def __init__(self, array: 'ArrayConfig', environment: 'TargetEnvironment'):
        self.array = array
        self.environment = environment

    def compute_channel_data(self, num_samples: int, sampling_rate_mhz: float):
        num_elements = len(self.array.elements)
        channel_data = np.zeros((num_elements, num_samples))

        t = np.arange(num_samples) / sampling_rate_mhz
        c = self.array.wave_speed
        fc = 5.0
        pulse_width = 0.2

        x_positions = self.array._element_x_positions()

        angle_rad = np.deg2rad(self.array.steering_angle)
        tx_delays = (x_positions * np.sin(angle_rad)) / c
        tx_delays -= np.min(tx_delays)

        # --- OPTIMIZATION 1: Extract all Scatterers at once ---
        scat_x = np.array([s.x for s in self.environment.scatterers])
        scat_z = np.array([s.z for s in self.environment.scatterers])
        scat_a = np.array([s.reflectivity for s in self.environment.scatterers])

        # --- OPTIMIZATION 2: Vectorized Distances ---
        # Calculate distance from ALL elements to ALL scatterers simultaneously
        # Resulting shape: (num_elements, num_scatterers)
        dx = x_positions[:, np.newaxis] - scat_x[np.newaxis, :]
        dz = scat_z[np.newaxis, :]
        distances = np.sqrt(dx**2 + dz**2)

        # Calculate Times of Flight
        rx_tofs = distances / c                                 # (num_rx, num_scat)
        tx_tofs = (distances / c) + tx_delays[:, np.newaxis]    # (num_tx, num_scat)

        # Total ToF for every combination of Rx, Tx, Scatterer
        # Resulting Shape: (num_rx, num_tx, num_scat)
        total_tofs = rx_tofs[:, np.newaxis, :] + tx_tofs[np.newaxis, :, :]

        # Convert the continuous float arrival times into integer index bins
        tof_indices = (total_tofs * sampling_rate_mhz).astype(int)

        # --- OPTIMIZATION 3: Build the System Impulse Response ---
        impulse_response = np.zeros((num_elements, num_samples))

        # We broadcast the reflectivities so every Tx "hears" the scatterer amplitude
        weights = np.broadcast_to(scat_a[np.newaxis, :], (num_elements, len(scat_a))).flatten()

        for rx in range(num_elements):
            # Flatten the Tx and Scatterer indices for this specific Rx channel
            idx_flat = tof_indices[rx, :, :].flatten()

            # Filter out echoes that bounce back after our max recording depth
            valid_mask = (idx_flat >= 0) & (idx_flat < num_samples)

            # Fast accumulation: Drops the amplitudes into the correct time slots
            # np.bincount is executed in compiled C, making it virtually instantaneous
            rx_impulse = np.bincount(idx_flat[valid_mask], weights=weights[valid_mask], minlength=num_samples)
            impulse_response[rx, :] = rx_impulse[:num_samples]

        # --- OPTIMIZATION 4: Single Base Pulse Convolution ---
        # Generate the wave only covering the actual width of the pulse
        half_len = int(3 * pulse_width * sampling_rate_mhz)
        t_pulse = np.arange(-half_len, half_len + 1) / sampling_rate_mhz
        base_pulse = np.cos(2 * np.pi * fc * t_pulse) * np.exp(-(t_pulse**2) / (pulse_width**2))

        # Convolve the impulses with the base pulse
        for rx in range(num_elements):
            # fftconvolve uses Fast Fourier Transforms under the hood
            channel_data[rx, :] = fftconvolve(impulse_response[rx, :], base_pulse, mode='same')

        return channel_data, t