import math
from dataclasses import dataclass
from typing import List, Optional

import numpy as np

from Objects.ArrayConfig import ArrayConfig
from Objects.Physics.RadarEnviroment import RadarEnvironment, RadarTarget
from Objects.Scenarios.Scenario import Scenario

# ── Physical constants ─────────────────────────────────────────────────────────
_C          = 3.0e8                                    # speed of light, m/s
_4PI3_DB    = 10.0 * math.log10((4.0 * math.pi) ** 3)  # ≈ 33.0 dB
_EFF_DB     = -1.5                                     # aperture efficiency (empirical)


@dataclass(frozen=True)
class RadarWaveform:
    pt_dbm:         float = 70.0    # peak transmit power, dBm
    prf_hz:         float = 1000.0  # pulse repetition frequency, Hz
    pulse_width_us: float = 1.0     # pulse width, microseconds

    @property
    def max_unambiguous_range_m(self) -> float:
        return _C / (2.0 * self.prf_hz)

    @property
    def range_resolution_m(self) -> float:
        return (_C * self.pulse_width_us * 1e-6) / 2.0


@dataclass(frozen=True)
class RadarDetectionConfig:
    guard_cells: int   = 2
    ref_cells:   int   = 8
    pfa:         float = 1e-4


@dataclass
class RadarDetection:
    target_id:     str
    range_m:       float
    angle_deg:     float
    snr_db:        float
    estimated_rcs: float
    doppler_m_s:   float


@dataclass
class RadarScanResult:
    timestamp:  float
    detections: List[RadarDetection]
    sweep_data: List[dict]


def compute_cfar_threshold(power_bins: np.ndarray, cfg: RadarDetectionConfig) -> np.ndarray:
    """Compute the CA-CFAR detection threshold for every range bin."""
    n       = len(power_bins)
    n_ref   = 2 * cfg.ref_cells
    alpha   = n_ref * (cfg.pfa ** (-1.0 / n_ref) - 1.0)
    half_w  = cfg.guard_cells + cfg.ref_cells

    thresholds = np.full(n, np.nan)

    for k in range(n):
        left  = power_bins[max(0, k - half_w) : max(0, k - cfg.guard_cells)]
        right = power_bins[min(n, k + cfg.guard_cells + 1) : min(n, k + half_w + 1)]
        ref   = np.concatenate([left, right])
        if len(ref) > 0:
            thresholds[k] = alpha * float(np.mean(ref))

    valid = ~np.isnan(thresholds)
    if valid.any():
        idx         = np.where(valid, np.arange(n), 0)
        np.maximum.accumulate(idx, out=idx)
        thresholds  = thresholds[idx]
        idx2        = np.where(valid, np.arange(n), n - 1)
        idx2        = idx2[::-1]
        np.minimum.accumulate(idx2, out=idx2)
        thresholds  = np.minimum(thresholds, thresholds[idx2[::-1]])

    nan_mask = np.isnan(thresholds)
    if nan_mask.any():
        thresholds[nan_mask] = float(np.mean(power_bins))

    return thresholds


class RadarScenario(Scenario):
    """Phased-array radar PPI scan engine with a physically correct signal model."""
    def __init__(
        self,
        config:        ArrayConfig,
        environment:   RadarEnvironment,
        waveform:      Optional[RadarWaveform]        = None,
        detection_cfg: Optional[RadarDetectionConfig] = None,
    ) -> None:
        super().__init__(config, environment)

        self._waveform      : RadarWaveform        = waveform      or RadarWaveform()
        self._detection_cfg : RadarDetectionConfig = detection_cfg or RadarDetectionConfig()
        self.config.wave_speed = _C

    @property
    def waveform(self) -> RadarWaveform:
        return self._waveform

    @property
    def detection_cfg(self) -> RadarDetectionConfig:
        return self._detection_cfg

    @property
    def carrier_freq_hz(self) -> float:
        enabled = [el for el in self.config.elements if el.enabled]
        return (enabled[0].frequency if enabled else 9_500.0) * 1e6

    @property
    def wavelength_m(self) -> float:
        return _C / self.carrier_freq_hz

    @property
    def array_gain_db(self) -> float:
        n = max(sum(1 for el in self.config.elements if el.enabled), 1)
        return 10.0 * math.log10(n) + _EFF_DB

    @property
    def hpbw_deg(self) -> float:
        n    = max(sum(1 for el in self.config.elements if el.enabled), 1)
        d_m  = self.config.element_spacing / 1_000.0
        apert = max((n - 1) * d_m, d_m)
        return min(90.0, math.degrees(0.886 * self.wavelength_m / apert))

    def update_config(self, new_config: ArrayConfig) -> None:
        super().update_config(new_config)
        self.config.wave_speed = _C

    def get_scan_parameters(self) -> dict:
        return {
            "carrier_freq_hz":         self.carrier_freq_hz,
            "wavelength_m":            self.wavelength_m,
            "array_gain_db":           self.array_gain_db,
            "hpbw_deg":                self.hpbw_deg,
            "range_resolution_m":      self._waveform.range_resolution_m,
            "max_unambiguous_range_m": self._waveform.max_unambiguous_range_m,
            "pt_dbm":                  self._waveform.pt_dbm,
            "prf_hz":                  self._waveform.prf_hz,
            "pulse_width_us":          self._waveform.pulse_width_us,
            "noise_floor_dbm":         self.environment.noise_floor_dbm,
        }

    def perform_default_scan(
        self,
        max_range_m:    float = 150_000.0,
        num_lines:      int   = 360,
        num_range_bins: int   = 128,
    ) -> RadarScanResult:
        return self.generate_ppi_scan(
            start_angle    = 0.0,
            end_angle      = 359.0,
            num_lines      = num_lines,
            max_range_m    = max_range_m,
            num_range_bins = num_range_bins,
        )

    def generate_ppi_scan(
        self,
        start_angle:    float,
        end_angle:      float,
        num_lines:      int,
        max_range_m:    float,
        num_range_bins: int = 128,
    ) -> RadarScanResult:
        angles_deg  = np.linspace(start_angle, end_angle, max(num_lines, 1))
        ranges_m    = np.linspace(
            self._waveform.range_resolution_m,
            max_range_m,
            num_range_bins,
        )
        bin_width_m = float(ranges_m[1] - ranges_m[0]) if num_range_bins > 1 else max_range_m

        sweep_data : List[dict]           = []
        detections : List[RadarDetection] = []

        lam_db  = 20.0 * math.log10(self.wavelength_m)
        g0_db   = self.array_gain_db
        pt_dbm  = self._waveform.pt_dbm

        for steer_angle in angles_deg:
            self.config.steering_angle = float(steer_angle)
            self.config.calculate_steering_delays()

            beam_result = self.config.compute_beamforming(
                num_samples           = 128,
                calculate_time_domain = False,
            )

            bp_db  = np.asarray(beam_result.beam_pattern_db) 
            bp_ang = np.asarray(beam_result.angles_deg)     

            power_bins = np.zeros(num_range_bins, dtype=float)

            for target in self.environment.targets:
                r       = target.range_m
                bearing = target.bearing_deg

                if r > max_range_m or r < 1.0:
                    continue

                rel_ang = (bearing - float(steer_angle) + 180.0) % 360.0 - 180.0
                rel_ang = max(-90.0, min(90.0, rel_ang))

                relative_gain_db = float(np.interp(rel_ang, bp_ang, bp_db))
                one_way_gain_db  = g0_db + relative_gain_db

                pr_dbm = (
                    pt_dbm
                    + 2.0 * one_way_gain_db     
                    + lam_db                    
                    + target.rcs_db             
                    - _4PI3_DB                  
                    - 40.0 * math.log10(max(r, 1.0))  
                )

                snr_db     = pr_dbm - self.environment.noise_plus_clutter_dbm(r)
                snr_linear = 10.0 ** (snr_db / 10.0)

                bin_idx = int(np.argmin(np.abs(ranges_m - r)))
                power_bins[bin_idx] += snr_linear

            cfar_thr = compute_cfar_threshold(power_bins, self._detection_cfg)

            for bin_idx in range(num_range_bins):
                if power_bins[bin_idx] <= cfar_thr[bin_idx]:
                    continue

                bin_range  = float(ranges_m[bin_idx])
                snr_db_bin = 10.0 * math.log10(max(power_bins[bin_idx], 1e-30))

                for target in self.environment.targets:
                    if abs(target.range_m - bin_range) > bin_width_m:
                        continue

                    ang_sep = abs((target.bearing_deg - float(steer_angle) + 180) % 360 - 180)
                    if ang_sep > self.hpbw_deg / 2.0:
                        continue

                    fd          = 2.0 * target.velocity_m_s * self.carrier_freq_hz / _C
                    doppler_m_s = fd * self.wavelength_m / 2.0

                    detections.append(RadarDetection(
                        target_id     = target.target_id,
                        range_m       = round(target.range_m, 1),
                        angle_deg     = round(float(steer_angle), 1),
                        snr_db        = round(snr_db_bin, 1),
                        estimated_rcs = target.rcs_sqm,
                        doppler_m_s   = round(doppler_m_s, 2),
                    ))

            sweep_data.append({
                "angle_deg":  float(steer_angle),
                "range_bins": self._log_compress(power_bins).tolist(),
            })

        return RadarScanResult(
            timestamp  = 0.0,
            detections = detections,
            sweep_data = sweep_data,
        )

    @staticmethod
    def _log_compress(
        power_bins:      np.ndarray,
        dynamic_range_db: float = 40.0,
    ) -> np.ndarray:
        eps       = 1e-30
        power_db  = 10.0 * np.log10(np.maximum(power_bins, eps))
        peak_db   = float(np.max(power_db))
        floor_db  = peak_db - dynamic_range_db
        return np.clip((power_db - floor_db) / dynamic_range_db, 0.0, 1.0)