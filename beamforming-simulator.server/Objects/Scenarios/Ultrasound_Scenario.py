from dataclasses import dataclass
from typing import List, Union
import numpy as np
from Objects.ArrayConfig import ArrayConfig
from Objects.Physics.TargetEnviroment import TargetEnvironment
from Objects.Physics.DynamicEnviroment import DynamicEnvironment, MovingScatterer
from Objects.Scenarios.Scenario import Scenario
from Objects.Physics.PulseEchoEngine import PulseEchoEngine
from scipy.signal import hilbert

@dataclass
class AModeResult:
    angle_deg: float
    depths_mm: List[float]
    amplitudes: List[float]

@dataclass
class BModeResult:
    sector_angles_deg: List[float]
    axial_depths_mm: List[float]
    image_grid: List[List[float]]

@dataclass
class DopplerResult:
    angle_deg: float
    depths_mm: List[float]
    velocities_ms: List[float]  # Estimated velocity (+ is towards probe, - is away)
    power: List[float]          # Doppler power for color thresholding


@dataclass
class ColorDopplerResult:
    sector_angles_deg: List[float]
    axial_depths_mm: List[float]
    velocity_grid: List[List[float]]  # 2D array of velocities (m/s)
    power_grid: List[List[float]]     # 2D array of Doppler power (dB) for thresholding

class UltrasoundScenario(Scenario):
    """
    Unified acoustic scenario for static imaging (B-Mode) and moving imaging (Doppler).
    """
    def __init__(
        self,
        config: 'ArrayConfig',
        # Pythonic "Overload": Accept either the base static env or the dynamic env
        environment: Union['TargetEnvironment', 'DynamicEnvironment'],
        engine: 'PulseEchoEngine'
    ):
        super().__init__(config, environment)
        self._engine = engine

    def perform_default_scan(self, max_depth_mm: float = 50.0) -> BModeResult:
        """Standard behavior for ultrasound: A 90-degree B-Mode sweep."""
        return self.generate_b_mode(start_angle=-45.0, end_angle=45.0, num_lines=64, max_depth_mm=max_depth_mm)

    def _beamform_raw_rf(self, angle_deg: float, max_depth_mm: float) -> np.ndarray:
        self.config.steering_angle = angle_deg
        self.config.calculate_steering_delays()

        sampling_rate_mhz = 40.0
        c = self.config.wave_speed
        max_time_us = (2.0 * max_depth_mm) / c
        num_samples = int(max_time_us * sampling_rate_mhz)

        # This is likely your other bottleneck (see step 2 below)
        channel_data, time_vector = self._engine.compute_channel_data(num_samples, sampling_rate_mhz)

        num_depth_samples = len(time_vector)
        depths_mm = np.linspace(0.1, max_depth_mm, num_depth_samples)

        angle_rad = np.deg2rad(angle_deg)
        x_positions = self.config._element_x_positions()

        tx_delays_raw = (x_positions * np.sin(angle_rad)) / c
        delay_offset = -np.min(tx_delays_raw)

        x_line = depths_mm * np.sin(angle_rad)
        z_line = depths_mm * np.cos(angle_rad)

        # --- OPTIMIZATION: Vectorized Time of Flight Calculation ---
        # Reshape to allow broadcasting:
        # x_positions becomes a column (num_elements, 1)
        # x_line, z_line become rows (1, num_depths)
        dx = x_line[np.newaxis, :] - x_positions[:, np.newaxis]
        dz = z_line[np.newaxis, :]  # Assuming element z is 0

        # Calculate all distances at once (Shape: num_elements x num_depth_samples)
        rx_distances = np.sqrt(dx**2 + dz**2)

        # Calculate all times of flight at once
        times_of_flight = (depths_mm[np.newaxis, :] / c) + (rx_distances / c) + delay_offset

        # --- Fast Interpolation ---
        summed_rf_signal = np.zeros(num_depth_samples)

        for i, el in enumerate(self.config.elements):
            if not el.enabled:
                continue
            # np.interp is still called, but the math leading up to it is now instantly computed in C
            aligned_signal = np.interp(times_of_flight[i], time_vector, channel_data[i])
            summed_rf_signal += aligned_signal * el.apodization_weight

        return summed_rf_signal, depths_mm

    def generate_a_mode(self, angle_deg: float, max_depth_mm: float) -> AModeResult:
        """Generates standard amplitude envelopes for structural imaging."""
        summed_rf_signal, depths_mm = self._beamform_raw_rf(angle_deg, max_depth_mm)

        analytic_signal = hilbert(summed_rf_signal)
        envelope = np.abs(analytic_signal)

        return AModeResult(angle_deg=angle_deg, depths_mm=depths_mm.tolist(), amplitudes=envelope.tolist())

    def generate_b_mode(self, start_angle: float, end_angle: float, num_lines: int, max_depth_mm: float) -> BModeResult:
        """Generates 2D structural B-mode image."""
        sector_angles = np.linspace(start_angle, end_angle, num_lines)
        image_grid = []
        axial_depths = []

        for angle in sector_angles:
            print("Processig Sector Angle:", angle)
            a_mode = self.generate_a_mode(angle_deg=angle, max_depth_mm=max_depth_mm)
            image_grid.append(a_mode.amplitudes)
            if len(axial_depths) == 0:
                axial_depths = a_mode.depths_mm

        image_matrix = np.array(image_grid)
        max_env = np.max(image_matrix) if np.max(image_matrix) > 0 else 1.0

        image_db = 20.0 * np.log10((image_matrix / max_env) + 1e-9)
        dynamic_range = 50.0
        pixel_intensities = np.clip(image_db + dynamic_range, 0, dynamic_range)

        return BModeResult(
            sector_angles_deg=sector_angles.tolist(),
            axial_depths_mm=axial_depths,
            image_grid=pixel_intensities.tolist()
        )

    def generate_doppler_line(self, angle_deg: float, max_depth_mm: float, prf_hz: float = 4000.0, packet_size: int = 8) -> DopplerResult:
        """
        Calculates fluid velocities using the Kasai Autocorrelation algorithm.
        Gracefully handles both static and dynamic environments.
        """
        c = self.config.wave_speed
        f0 = getattr(self.config, 'center_frequency_hz', 5.0e6)
        prt_seconds = 1.0 / prf_hz

        ensemble = []
        depths = None

        # 1. Fire a packet of pulses down the same line (Slow-Time)
        for _ in range(packet_size):
            raw_rf, depths_mm = self._beamform_raw_rf(angle_deg, max_depth_mm)
            if depths is None:
                depths = depths_mm

            # Complex analytic signal required for phase calculations
            analytic_signal = hilbert(raw_rf)
            ensemble.append(analytic_signal)

            # Polymorphic Check: Only advance time if the environment supports it
            if hasattr(self.environment, 'advance_time'):
                self.environment.advance_time(prt_seconds)

        ensemble = np.array(ensemble).T # Shape: (depth_samples, packet_size)

        # --- ADD THIS: Basic Wall / Clutter Filter ---
        # Subtract the mean of the packet along the slow-time axis to remove stationary signals
        ensemble = ensemble - np.mean(ensemble, axis=1, keepdims=True)
        
        # 2. Kasai Autocorrelation Estimator
        z_curr = ensemble[:, 1:]

        # 2. Kasai Autocorrelation Estimator
        z_curr = ensemble[:, 1:]
        z_prev = ensemble[:, :-1]

        # Autocorrelation at lag 1
        R1 = np.sum(z_curr * np.conjugate(z_prev), axis=1)
        delta_phi = np.angle(R1) # Phase shift

        # Power calculation (used to threshold noise)
        power = np.sum(np.abs(ensemble)**2, axis=1) / packet_size

        # 3. Convert phase shift to velocity (m/s)
        c_ms = c * 1000 # convert from mm/us to m/s
        velocities_ms = (c_ms * prf_hz * delta_phi) / (4 * np.pi * f0)

        return DopplerResult(
            angle_deg=angle_deg,
            depths_mm=depths.tolist(),
            velocities_ms=velocities_ms.tolist(),
            power=power.tolist()
        )

    def generate_color_doppler(
        self,
        start_angle: float,
        end_angle: float,
        num_lines: int,
        max_depth_mm: float,
        prf_hz: float = 4000.0,
        packet_size: int = 8
    ) -> ColorDopplerResult:
        """
        Generates a 2D Color Doppler image by sweeping the Doppler packet across a sector.
        Returns both velocity grids and power grids (for noise thresholding).
        """
        sector_angles = np.linspace(start_angle, end_angle, num_lines)
        velocity_grid = []
        raw_power_grid = []
        axial_depths = []

        # 1. Gather all Doppler lines
        for angle in sector_angles:
            print("Processing Doppler Angle:", angle)
            doppler_line = self.generate_doppler_line(
                angle_deg=angle,
                max_depth_mm=max_depth_mm,
                prf_hz=prf_hz,
                packet_size=packet_size
            )

            velocity_grid.append(doppler_line.velocities_ms)
            raw_power_grid.append(doppler_line.power)

            if len(axial_depths) == 0:
                axial_depths = doppler_line.depths_mm

        # 2. Normalize Power to dB for easier thresholding
        # Note: We use 10*log10 here because this is POWER, whereas B-Mode used 20*log10 for AMPLITUDE
        power_matrix = np.array(raw_power_grid)
        max_power = np.max(power_matrix) if np.max(power_matrix) > 0 else 1.0

        power_db = 10.0 * np.log10((power_matrix / max_power) + 1e-9)

        # Clip to a dynamic range (e.g., 40 dB)
        dynamic_range = 40.0
        power_intensities = np.clip(power_db + dynamic_range, 0, dynamic_range)

        return ColorDopplerResult(
            sector_angles_deg=sector_angles.tolist(),
            axial_depths_mm=axial_depths,
            velocity_grid=velocity_grid, # Raw velocities in m/s
            power_grid=power_intensities.tolist() # Normalized dB power for thresholding
        )