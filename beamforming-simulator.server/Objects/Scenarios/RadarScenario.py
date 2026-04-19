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
    target_id: str
    range_m: float
    angle_deg: float
    snr_db: float
    estimated_rcs: float

@dataclass
class RadarScanResult:
    timestamp: float
    detections: List[RadarDetection]
    sweep_data: List[dict]  # list of {angle_deg, range_bins: List[float]}

class RadarScenario:
    def __init__(self, config: 'ArrayConfig', environment: RadarEnvironment):
        self.config = config
        self.environment = environment
        self.config.wave_speed = 300000.0

    def generate_ppi_scan(
        self,
        start_angle: float,
        end_angle: float,
        num_lines: int,
        max_range_m: float,
    ) -> RadarScanResult:
        angles_deg   = np.linspace(start_angle, end_angle, num_lines)
        num_range_bins = 128
        ranges_m     = np.linspace(0.1, max_range_m, num_range_bins)

        Pt_dbm       = 60.0
        sweep_data   = []
        detections   = []

        for steer_angle in angles_deg:
            self.config.steering_angle = steer_angle
            self.config.calculate_steering_delays()

            beam_result  = self.config.compute_beamforming(
                num_samples=128, calculate_time_domain=False
            )
            range_bins   = [0.0] * num_range_bins

            for target in self.environment.targets:
                true_range   = np.sqrt(target.x_m ** 2 + target.y_m ** 2)
                true_angle_deg = np.rad2deg(np.arctan2(target.x_m, target.y_m))

                if true_range > max_range_m:
                    continue

                idx_a        = int(np.argmin(np.abs(
                    np.array(beam_result.angles_deg) - true_angle_deg
                )))
                antenna_gain_db = beam_result.beam_pattern_db[idx_a]
                path_loss_db = 40.0 * np.log10(max(true_range, 0.1))
                Pr_dbm       = (Pt_dbm + 2 * antenna_gain_db
                                + 10 * np.log10(max(target.rcs_sqm, 1e-6))
                                - path_loss_db)
                snr_db       = Pr_dbm - self.environment.noise_floor_dbm

                if snr_db > 10.0:
                    idx_r = int(np.argmin(np.abs(ranges_m - true_range)))
                    # Normalise SNR to 0-1 for intensity
                    range_bins[idx_r] = min(1.0, snr_db / 60.0)

                    if antenna_gain_db > -3.0:
                        detections.append(RadarDetection(
                            target_id  = target.target_id,
                            range_m    = round(true_range, 1),
                            angle_deg  = round(steer_angle, 1),
                            snr_db     = round(snr_db, 1),
                            estimated_rcs = target.rcs_sqm,
                        ))

            sweep_data.append({
                'angle_deg' : float(steer_angle),
                'range_bins': range_bins,
            })

        return RadarScanResult(
            timestamp  = 0.0,
            detections = detections,
            sweep_data = sweep_data,
        )
