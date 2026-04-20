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
        self.config.steering_angle = angle_deg
        self.config.calculate_steering_delays()
        
        sampling_rate_mhz = 40.0 
        c = self.config.wave_speed
        max_time_us = (2.0 * max_depth_mm) / c 
        num_samples = int(max_time_us * sampling_rate_mhz)
        
        channel_data, time_vector = self._engine.compute_channel_data(num_samples, sampling_rate_mhz)
        
        num_depth_samples = len(time_vector)
        depths_mm = np.linspace(0.1, max_depth_mm, num_depth_samples)
        summed_rf_signal = np.zeros(num_depth_samples)
        
        angle_rad = np.deg2rad(angle_deg)
        x_positions = self.config._element_x_positions()
        
        # Calculate the exact time shift that the engine applied during transmit
        tx_delays_raw = (x_positions * np.sin(angle_rad)) / c
        delay_offset = -np.min(tx_delays_raw) # This is how much the pulse was delayed
        
        x_line = depths_mm * np.sin(angle_rad)
        z_line = depths_mm * np.cos(angle_rad)
        
        for i, el in enumerate(self.config.elements):
            if not el.enabled:
                continue
            rx_distances = np.sqrt((x_line - x_positions[i])**2 + z_line**2)
            
            # ADD the delay_offset so the receiver waits for the delayed pulse
            times_of_flight = (depths_mm / c) + (rx_distances / c) + delay_offset
            
            aligned_signal = np.interp(times_of_flight, time_vector, channel_data[i])
            summed_rf_signal += aligned_signal * el.apodization_weight
            
        analytic_signal = hilbert(summed_rf_signal)
        envelope = np.abs(analytic_signal)
        
        # IMPORTANT: Do NOT convert to dB here! Return the raw envelope.
        return AModeResult(angle_deg=angle_deg, depths_mm=depths_mm.tolist(), amplitudes=envelope.tolist())


    def generate_b_mode(self, start_angle: float, end_angle: float, num_lines: int, max_depth_mm: float) -> BModeResult:
        sector_angles = np.linspace(start_angle, end_angle, num_lines)
        image_grid = []
        axial_depths = []
        
        # 1. Gather all raw envelopes
        for angle in sector_angles:
            a_mode = self.generate_a_mode(angle_deg=angle, max_depth_mm=max_depth_mm)
            image_grid.append(a_mode.amplitudes)
            if len(axial_depths) == 0:
                axial_depths = a_mode.depths_mm
                
        # 2. Apply Global dB Normalization across the ENTIRE image
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
    

