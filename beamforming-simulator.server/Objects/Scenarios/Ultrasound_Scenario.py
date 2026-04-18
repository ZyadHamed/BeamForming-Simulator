from dataclasses import dataclass
from typing import List
import numpy as np
from ArrayConfig import ArrayConfig
from Physics.TargetEnviroment import TargetEnvironment
from Scenario import Scenario
from Physics.PulseEchoEngine import PulseEchoEngine
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



class UltrasoundScenario(Scenario):
    """
    Acoustic scenario optimized for dense spatial sweeping and image generation.
    """
    def __init__(self, config: 'ArrayConfig', environment: 'TargetEnvironment', engine: 'PulseEchoEngine'):
        super().__init__(config, environment)
        # We inject the physics engine here so the scenario can trigger it
        self._engine = engine 

    def perform_default_scan(self, max_depth_mm: float = 50.0) -> BModeResult:
        """Standard behavior for ultrasound: A 90-degree B-Mode sweep."""
        return self.generate_b_mode(start_angle=-45.0, end_angle=45.0, num_lines=64, max_depth_mm=max_depth_mm)

    def generate_a_mode(self, angle_deg: float, max_depth_mm: float) -> AModeResult:
            """
            Steers the transmit beam, receives the raw channel data, 
            applies Delay-and-Sum, and extracts the envelope.
            """
            # 1. Update the Transmit Array to steer in the requested direction
            self.config.steering_angle = angle_deg
            self.config.calculate_steering_delays()
            
            # --- FIX 1: Calculate num_samples from max_depth_mm ---
            sampling_rate_mhz = 40.0  # standard high-res sampling rate
            c = self.config.wave_speed
            max_time_us = (2.0 * max_depth_mm) / c  # Round-trip time
            num_samples = int(max_time_us * sampling_rate_mhz)
            
            # 2. Fire the engine! Get the raw (noisy) time-domain data from every element
            # --- FIX 2: Pass the correct arguments ---
            channel_data, time_vector = self._engine.compute_channel_data(num_samples, sampling_rate_mhz)
            
            # 3. Setup for Receive Beamforming (Delay-and-Sum)
            num_depth_samples = len(time_vector)
            depths_mm = np.linspace(0.1, max_depth_mm, num_depth_samples)
            summed_rf_signal = np.zeros(num_depth_samples)
            
            angle_rad = np.deg2rad(angle_deg)
            x_positions = self.config._element_x_positions()
            
            # Calculate the (x, z) coordinates of every pixel along our steering line
            x_line = depths_mm * np.sin(angle_rad)
            z_line = depths_mm * np.cos(angle_rad)
            
            # 4. The Delay-and-Sum (DAS) Loop
            for i, el in enumerate(self.config.elements):
                if not el.enabled:
                    continue
                
                # Distance from each point on the line back to this specific element
                rx_distances = np.sqrt((x_line - x_positions[i])**2 + z_line**2)
                
                # Total round-trip distance (Transmit depth + Receive distance)
                total_distances = depths_mm + rx_distances
                
                # Convert distance to expected Time of Flight
                times_of_flight = total_distances / c
                
                # Dynamically pull the exact voltage recorded at that specific time 
                aligned_signal = np.interp(times_of_flight, time_vector, channel_data[i])
                
                # Apply apodization window and sum it up
                summed_rf_signal += aligned_signal * el.apodization_weight
                
            # 5. Envelope Detection
            analytic_signal = hilbert(summed_rf_signal)
            envelope = np.abs(analytic_signal)
            
            # 6. Log Compression
            max_env = np.max(envelope) if np.max(envelope) > 0 else 1.0
            envelope_db = 20.0 * np.log10((envelope / max_env) + 1e-9)
            
            dynamic_range = 50.0 
            pixel_intensities = np.clip(envelope_db + dynamic_range, 0, dynamic_range)
            
            return AModeResult(
                angle_deg=angle_deg,
                depths_mm=depths_mm.tolist(),
                amplitudes=pixel_intensities.tolist()
            )

    def generate_b_mode(self, start_angle: float, end_angle: float, num_lines: int, max_depth_mm: float) -> BModeResult:
        """
        Sweeps the beam across a sector, generating an A-mode for each step, 
        and packs them into a 2D image matrix.
        """
        sector_angles = np.linspace(start_angle, end_angle, num_lines)
        image_grid = []
        axial_depths = []
        
        for angle in sector_angles:
            # Call our A-mode function for every single line
            a_mode = self.generate_a_mode(angle_deg=angle, max_depth_mm=max_depth_mm)
            
            image_grid.append(a_mode.amplitudes)
            
            # We only need to save the depth axis once, as it's the same for all lines
            if len(axial_depths) == 0:
                axial_depths = a_mode.depths_mm
                
        return BModeResult(
            sector_angles_deg=sector_angles.tolist(),
            axial_depths_mm=axial_depths,
            image_grid=image_grid
        )