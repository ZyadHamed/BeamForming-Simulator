from dataclasses import dataclass
from typing import List
import numpy as np
import base64
import io
from PIL import Image

from Objects.ArrayConfig import ArrayConfig
from Objects.Physics.RadarEnviroment import RadarEnvironment

@dataclass
class RadarDetection:
    """A 'blip' on the radar screen that crossed the detection threshold."""
    range_m: float
    angle_deg: float
    snr_db: float
    estimated_rcs: float

@dataclass
class RadarScanResult:
    """The ultra-lightweight payload sent to the frontend UI."""
    timestamp: float
    detections: List[RadarDetection]
    # We send the background sweep (the "green glow" of the radar) as an image
    ppi_image_base64: str

class RadarScenario:
    def __init__(self, config: 'ArrayConfig', environment: RadarEnvironment):
        self.config = config
        self.environment = environment
        
        # Override the wave speed with the speed of light (millimeters per microsecond)
        # c = 3 * 10^8 m/s = 300000 mm/µs 
        self.config.wave_speed = 300000.0

    def generate_ppi_scan(self, start_angle: float, end_angle: float, num_lines: int, max_range_m: float) -> RadarScanResult:
        """
        Simulates a Plan Position Indicator (PPI) sector sweep.
        Returns a Base64 image of the sweep and a list of discrete target detections.
        """
        angles_deg = np.linspace(start_angle, end_angle, num_lines)
        num_range_bins = 256 # Downsampled range for UI performance
        ranges_m = np.linspace(0.1, max_range_m, num_range_bins)
        
        # This will hold the visual data for the radar sweep (Angle vs Range)
        sweep_matrix = np.zeros((num_lines, num_range_bins))
        detections = []
        
        # Standard Radar Parameters
        Pt_dbm = 60.0  # Transmit power (e.g., 1 kW)
        
        for a_idx, steer_angle in enumerate(angles_deg):
            # Steer the array
            self.config.steering_angle = steer_angle
            self.config.calculate_steering_delays()
            
            # Get the beam profile for this steering angle
            beam_result = self.config.compute_beamforming(num_samples=128, calculate_time_domain=False)
            
            for target in self.environment.targets:
                # Calculate target's true polar coordinates relative to the array (0,0)
                true_range = np.sqrt(target.x_m**2 + target.y_m**2)
                true_angle_rad = np.arctan2(target.x_m, target.y_m) 
                true_angle_deg = np.rad2deg(true_angle_rad)
                
                if true_range > max_range_m:
                    continue
                    
                # Fetch the antenna gain (dB) at the target's physical location
                idx = (np.abs(np.array(beam_result.angles_deg) - true_angle_deg)).argmin()
                antenna_gain_db = beam_result.beam_pattern_db[idx]
                
                # The Radar Equation (simplified for dB math)
                # Received Power is proportional to 1 / R^4
                path_loss_db = 40.0 * np.log10(true_range)
                
                # Two-way antenna gain (Tx + Rx) + RCS - Path Loss
                Pr_dbm = Pt_dbm + (2 * antenna_gain_db) + (10 * np.log10(target.rcs_sqm)) - path_loss_db
                
                snr_db = Pr_dbm - self.environment.noise_floor_dbm
                
                if snr_db > 10.0:  # 10 dB Detection Threshold
                    # Map it to the visual sweep matrix
                    r_idx = (np.abs(ranges_m - true_range)).argmin()
                    sweep_matrix[a_idx, r_idx] += snr_db
                    
                    # Log the discrete detection (prevent duplicates from side-lobe hits)
                    if antenna_gain_db > -3.0: # Only register as a strict detection if it's in the main lobe
                        detections.append(RadarDetection(
                            range_m=round(true_range, 1),
                            angle_deg=round(steer_angle, 1),
                            snr_db=round(snr_db, 1),
                            estimated_rcs=target.rcs_sqm
                        ))

        # --- Visual Polish: Convert sweep_matrix to a Base64 Image ---
        # Normalize the sweep matrix to 0-255 for grayscale image generation
        max_val = np.max(sweep_matrix) if np.max(sweep_matrix) > 0 else 1.0
        pixel_data = np.uint8((sweep_matrix / max_val) * 255)
        
        img = Image.fromarray(pixel_data, mode='L')
        buffer = io.BytesIO()
        img.save(buffer, format="PNG")
        b64_string = base64.b64encode(buffer.getvalue()).decode('utf-8')
        
        return RadarScanResult(
            timestamp=0.0, # Replace with time.time() if tracking history
            detections=detections,
            ppi_image_base64=f"data:image/png;base64,{b64_string}"
        )